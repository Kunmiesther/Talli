import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type ZodTypeAny, z } from 'zod';
import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';

export interface StructuredActionModelRequest<TSchema extends ZodTypeAny = ZodTypeAny> {
  systemInstructions: string;
  userInput: string;
  context: unknown;
  schemaName: string;
  schema: TSchema;
  contractName: string;
  contractVersion: string;
}

export interface StructuredActionModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StructuredActionModelAttemptLog {
  attempt: number;
  requestId: string;
  httpStatus?: number;
  responseFormatUsed: boolean;
  rawOutput: string;
  parseSucceeded: boolean;
  parseError?: string;
  schemaIssuePaths: string[];
  failureKind: 'success' | 'rate_limit' | 'provider_error' | 'parse_error' | 'schema_error';
  retryAfterMs?: number;
}

export interface StructuredActionModelDiagnostics {
  provider: string;
  model: string;
  baseUrl: string;
  configured: boolean;
  contractName: string;
  contractVersion: string;
  attempts: number;
  latencyMs: number;
  responseFormatUsed: boolean;
  rawOutputs: string[];
  parseErrors: string[];
  requestIds: string[];
  attemptLogs: StructuredActionModelAttemptLog[];
  rateLimitFailures: number;
  schemaInvalidResponses: number;
  providerFailures: number;
  usage?: StructuredActionModelUsage;
  failureReason?: string;
}

export type StructuredActionModelResult<TOutput = unknown> =
  | {
      ok: true;
      output: TOutput;
      diagnostics: StructuredActionModelDiagnostics;
    }
  | {
      ok: false;
      diagnostics: StructuredActionModelDiagnostics;
    };

export interface StructuredActionModel {
  readonly provider: string;
  readonly model: string;
  generateStructuredResponse<TSchema extends ZodTypeAny>(
    request: StructuredActionModelRequest<TSchema>,
  ): Promise<StructuredActionModelResult<z.infer<TSchema>>>;
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const fallback = 'https://api.openai.com/v1';
  const trimmed = stripWrappingQuotes(baseUrl?.trim());
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/\/+$/, '');
}

function stripWrappingQuotes(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function loadLocalEnvFallback(): void {
  if (process.env.OPENAI_API_KEY) {
    return;
  }

  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue) ?? rawValue;
  }
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
  contractName: string,
  contractVersion: string,
): StructuredActionModelDiagnostics {
  return {
    provider,
    model,
    baseUrl,
    configured,
    contractName,
    contractVersion,
    attempts: 0,
    latencyMs: 0,
    responseFormatUsed: true,
    rawOutputs: [],
    parseErrors: [],
    requestIds: [],
    attemptLogs: [],
    rateLimitFailures: 0,
    schemaInvalidResponses: 0,
    providerFailures: 0,
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

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const until = new Date(headerValue);
  if (Number.isNaN(until.getTime())) {
    return null;
  }

  return Math.max(0, until.getTime() - Date.now());
}

function getSchemaIssuePaths(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) {
    return [];
  }

  return error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '<root>'));
}

function getSchemaIssueMessages(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) {
    return [error instanceof Error ? error.message : 'Schema validation failed.'];
  }

  return error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`,
  );
}

function isRateLimitError(status: number, body: string): boolean {
  return status === 429 || /rate limit|too many requests|retry after/i.test(body);
}

function isUnsupportedResponseFormatError(body: string): boolean {
  return /response_format|json_object|unsupported|invalid/i.test(body);
}

export class OpenAICompatibleStructuredActionModel implements StructuredActionModel {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxAttempts?: number;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.maxAttempts = options.maxAttempts ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  async generateStructuredResponse<TSchema extends ZodTypeAny>(
    request: StructuredActionModelRequest<TSchema>,
  ): Promise<StructuredActionModelResult<z.infer<TSchema>>> {
    const startedAt = performance.now();
    const diagnostics = createDiagnosticsBase(
      this.provider,
      this.model,
      this.baseUrl,
      Boolean(this.apiKey),
      request.contractName,
      request.contractVersion,
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
                  `The previous response was invalid for ${request.contractName} v${request.contractVersion}. ` +
                  `Reason: ${lastError}. Return only a single JSON object that matches the contract.`,
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

      let responseText = '';
      let requestId = '';
      let httpStatus: number | undefined;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        httpStatus = response.status;
        responseText = await response.text();
        requestId = response.headers.get('x-request-id') ?? '';

        if (!response.ok) {
          diagnostics.rawOutputs.push(responseText.trim() || `HTTP ${response.status}`);
          diagnostics.requestIds.push(requestId);

          const rateLimited = isRateLimitError(response.status, responseText);
          if (rateLimited) {
            diagnostics.rateLimitFailures += 1;
            const retryAfterMs =
              parseRetryAfter(response.headers.get('retry-after')) ??
              Math.min(4000, 500 * 2 ** Math.max(0, attempt - 1));
            diagnostics.providerFailures += 1;
            diagnostics.attemptLogs.push({
              attempt,
              requestId,
              httpStatus,
              responseFormatUsed: structuredOutputRequested,
              rawOutput: responseText.trim() || `HTTP ${response.status}`,
              parseSucceeded: false,
              parseError: responseText.trim() || `HTTP ${response.status}`,
              schemaIssuePaths: [],
              failureKind: 'rate_limit',
              retryAfterMs,
            });
            lastError = responseText.trim() || `HTTP ${response.status}`;
            if (attempt < this.maxAttempts) {
              await this.sleepImpl(retryAfterMs);
              continue;
            }
          } else {
            diagnostics.providerFailures += 1;
            diagnostics.parseErrors.push(responseText.trim() || `HTTP ${response.status}`);
            diagnostics.attemptLogs.push({
              attempt,
              requestId,
              httpStatus,
              responseFormatUsed: structuredOutputRequested,
              rawOutput: responseText.trim() || `HTTP ${response.status}`,
              parseSucceeded: false,
              parseError: responseText.trim() || `HTTP ${response.status}`,
              schemaIssuePaths: [],
              failureKind: 'provider_error',
            });
            lastError = responseText.trim() || `HTTP ${response.status}`;

            if (structuredOutputRequested && isUnsupportedResponseFormatError(responseText)) {
              structuredOutputRequested = false;
            }
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
          diagnostics.requestIds.push(requestId);
          diagnostics.providerFailures += 1;
          diagnostics.parseErrors.push(message);
          diagnostics.attemptLogs.push({
            attempt,
            requestId,
            httpStatus,
            responseFormatUsed: structuredOutputRequested,
            rawOutput: responseText,
            parseSucceeded: false,
            parseError: message,
            schemaIssuePaths: [],
            failureKind: 'parse_error',
          });
          lastError = message;
          continue;
        }

        const content = extractResponseContent(parsedResponse);
        diagnostics.rawOutputs.push(content);
        diagnostics.requestIds.push(parsedResponse.id ?? requestId);
        diagnostics.usage = toUsage(parsedResponse.usage);

        const parsed = request.schema.safeParse(parseModelOutput(content));
        if (parsed.success) {
          diagnostics.latencyMs = Math.round(performance.now() - startedAt);
          diagnostics.attemptLogs.push({
            attempt,
            requestId: parsedResponse.id ?? requestId,
            httpStatus,
            responseFormatUsed: structuredOutputRequested,
            rawOutput: content,
            parseSucceeded: true,
            schemaIssuePaths: [],
            failureKind: 'success',
          });
          return {
            ok: true,
            output: parsed.data,
            diagnostics,
          };
        }

        const issuePaths = parsed.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.join('.') : '<root>',
        );
        const messages = parsed.error.issues.map(
          (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`,
        );
        const message = messages.join(' | ') || 'Model response did not match the contract.';
        diagnostics.schemaInvalidResponses += 1;
        diagnostics.parseErrors.push(message);
        diagnostics.attemptLogs.push({
          attempt,
          requestId: parsedResponse.id ?? requestId,
          httpStatus,
          responseFormatUsed: structuredOutputRequested,
          rawOutput: content,
          parseSucceeded: false,
          parseError: message,
          schemaIssuePaths: issuePaths,
          failureKind: 'schema_error',
        });
        lastError = message;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider request failed.';
        diagnostics.providerFailures += 1;
        diagnostics.parseErrors.push(message);
        diagnostics.rawOutputs.push(message);
        diagnostics.attemptLogs.push({
          attempt,
          requestId,
          httpStatus,
          responseFormatUsed: structuredOutputRequested,
          rawOutput: message,
          parseSucceeded: false,
          parseError: message,
          schemaIssuePaths: [],
          failureKind: 'provider_error',
        });
        lastError = message;
      }
    }

    diagnostics.latencyMs = Math.round(performance.now() - startedAt);
    diagnostics.failureReason =
      lastError ?? 'The provider did not return a valid structured response.';
    return {
      ok: false,
      diagnostics,
    };
  }

  async generateLedgerAction(request: {
    systemInstructions: string;
    userInput: string;
    context: unknown;
    schemaName: string;
  }): Promise<StructuredActionModelResult<LedgerAction>> {
    return this.generateStructuredResponse({
      ...request,
      schema: ledgerActionSchema,
      contractName: 'LedgerAction',
      contractVersion: 'legacy-action-contract',
    });
  }
}

export function createConfiguredStructuredActionModel(): StructuredActionModel | null {
  loadLocalEnvFallback();
  const apiKey = stripWrappingQuotes(process.env.OPENAI_API_KEY?.trim());
  if (!apiKey) {
    return null;
  }

  return new OpenAICompatibleStructuredActionModel({
    apiKey,
    model: stripWrappingQuotes(process.env.OPENAI_MODEL?.trim()) || 'gpt-5',
    baseUrl: stripWrappingQuotes(process.env.OPENAI_BASE_URL?.trim()) || undefined,
  });
}
