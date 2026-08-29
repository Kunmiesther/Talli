import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';

export interface StructuredActionModelRequest {
  systemInstructions: string;
  userInput: string;
  context: unknown;
  schemaName: string;
}

export interface StructuredActionModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StructuredActionModelDiagnostics {
  provider: string;
  model: string;
  baseUrl: string;
  configured: boolean;
  attempts: number;
  latencyMs: number;
  responseFormatUsed: boolean;
  rawOutputs: string[];
  parseErrors: string[];
  requestIds: string[];
  usage?: StructuredActionModelUsage;
  failureReason?: string;
}

export type StructuredActionModelResult =
  | {
      ok: true;
      action: LedgerAction;
      diagnostics: StructuredActionModelDiagnostics;
    }
  | {
      ok: false;
      diagnostics: StructuredActionModelDiagnostics;
    };

export interface StructuredActionModel {
  readonly provider: string;
  readonly model: string;
  generateLedgerAction(request: StructuredActionModelRequest): Promise<StructuredActionModelResult>;
}

interface ChatCompletionsResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const fallback = 'https://api.openai.com/v1';
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/\/+$/, '');
}

function parseModelOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Model returned an empty response.');
  }

  return JSON.parse(trimmed) as unknown;
}

function extractResponseContent(response: ChatCompletionsResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('The model response did not contain assistant content.');
  }

  return content;
}

function createDiagnosticsBase(
  provider: string,
  model: string,
  baseUrl: string,
  configured: boolean,
): StructuredActionModelDiagnostics {
  return {
    provider,
    model,
    baseUrl,
    configured,
    attempts: 0,
    latencyMs: 0,
    responseFormatUsed: true,
    rawOutputs: [],
    parseErrors: [],
    requestIds: [],
  };
}

function toUsage(usage: ChatCompletionsResponse['usage']): StructuredActionModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

export class OpenAICompatibleStructuredActionModel implements StructuredActionModel {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxAttempts?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.maxAttempts = options.maxAttempts ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateLedgerAction(
    request: StructuredActionModelRequest,
  ): Promise<StructuredActionModelResult> {
    const startedAt = performance.now();
    const diagnostics = createDiagnosticsBase(
      this.provider,
      this.model,
      this.baseUrl,
      Boolean(this.apiKey),
    );
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    const baseMessages = [
      {
        role: 'system' as const,
        content: request.systemInstructions,
      },
      {
        role: 'user' as const,
        content: request.userInput,
      },
    ];

    let structuredOutputRequested = true;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      diagnostics.attempts = attempt;
      const messages =
        attempt === 1 || !lastError
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: 'assistant' as const,
                content: diagnostics.rawOutputs.at(-1) ?? '',
              },
              {
                role: 'user' as const,
                content:
                  `The previous response was invalid for ${request.schemaName}. ` +
                  `Reason: ${lastError}. Return only a single JSON object matching the schema.`,
              },
            ];

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: 0,
        top_p: 1,
      };
      if (structuredOutputRequested) {
        body.response_format = { type: 'json_object' };
      }

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const responseText = await response.text();

        if (!response.ok) {
          const responseError = responseText.trim() || `HTTP ${response.status}`;
          diagnostics.rawOutputs.push(responseError);
          diagnostics.requestIds.push(response.headers.get('x-request-id') ?? '');
          lastError = responseError;
          diagnostics.parseErrors.push(responseError);

          const shouldRetryWithoutStructuredOutput =
            structuredOutputRequested &&
            /response_format|json_object|unsupported|invalid/i.test(responseError);
          if (shouldRetryWithoutStructuredOutput) {
            structuredOutputRequested = false;
          }

          continue;
        }

        let parsedResponse: ChatCompletionsResponse;
        try {
          parsedResponse = JSON.parse(responseText) as ChatCompletionsResponse;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to parse provider response JSON.';
          diagnostics.rawOutputs.push(responseText);
          diagnostics.requestIds.push(response.headers.get('x-request-id') ?? '');
          diagnostics.parseErrors.push(message);
          lastError = message;
          continue;
        }

        const content = extractResponseContent(parsedResponse);
        diagnostics.rawOutputs.push(content);
        diagnostics.requestIds.push(
          parsedResponse.id ?? response.headers.get('x-request-id') ?? '',
        );
        diagnostics.usage = toUsage(parsedResponse.usage);

        try {
          const parsedAction = ledgerActionSchema.parse(parseModelOutput(content));
          diagnostics.latencyMs = Math.round(performance.now() - startedAt);
          return {
            ok: true,
            action: parsedAction,
            diagnostics,
          };
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Model response did not match the action schema.';
          diagnostics.parseErrors.push(message);
          lastError = message;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider request failed.';
        diagnostics.parseErrors.push(message);
        diagnostics.rawOutputs.push(message);
        lastError = message;
      }
    }

    diagnostics.latencyMs = Math.round(performance.now() - startedAt);
    diagnostics.failureReason = lastError ?? 'The provider did not return a valid action.';
    return {
      ok: false,
      diagnostics,
    };
  }
}

export function createConfiguredStructuredActionModel(): StructuredActionModel | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  return new OpenAICompatibleStructuredActionModel({
    apiKey,
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-5',
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
  });
}
