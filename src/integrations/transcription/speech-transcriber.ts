import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export interface SpeechTranscriptionInput {
  filePath: string;
  mimeType?: string;
}

export interface SpeechTranscriber {
  transcribe(input: SpeechTranscriptionInput): Promise<string>;
}

export interface SpeechTranscriberOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxFileBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
const DEFAULT_GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

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
  const initiallyConfiguredKeys = new Set(Object.keys(process.env));
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
    if (!key || initiallyConfiguredKeys.has(key)) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue) ?? rawValue;
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().replace(/\/+$/, '');
  return normalized || undefined;
}

function baseUrlMatchesHost(baseUrl: string, hostname: string): boolean {
  try {
    return new URL(baseUrl).hostname === hostname;
  } catch {
    return baseUrl.toLowerCase().includes(hostname.toLowerCase());
  }
}

function isGroqBaseUrl(baseUrl: string): boolean {
  return baseUrlMatchesHost(baseUrl, 'api.groq.com');
}

function isOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrlMatchesHost(baseUrl, 'api.openai.com');
}

export function resolveConfiguredTranscriptionModel(options: {
  baseUrl: string;
  explicitModel?: string;
}): string {
  if (options.explicitModel) {
    return options.explicitModel;
  }

  if (isGroqBaseUrl(options.baseUrl)) {
    return DEFAULT_GROQ_TRANSCRIPTION_MODEL;
  }

  if (options.baseUrl === DEFAULT_BASE_URL || isOpenAIBaseUrl(options.baseUrl)) {
    return DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  }

  throw new Error('TRANSCRIPTION_MODEL is required for this transcription base URL.');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export class OpenAICompatibleSpeechTranscriber implements SpeechTranscriber {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxFileBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SpeechTranscriberOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = normalizeBaseUrl(options.baseUrl) ?? DEFAULT_BASE_URL;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(input: SpeechTranscriptionInput): Promise<string> {
    const metadata = await stat(input.filePath);
    if (metadata.size <= 0) {
      throw new Error('Voice file is empty.');
    }
    if (metadata.size > this.maxFileBytes) {
      throw new Error('Voice file is too large.');
    }

    const bytes = await readFile(input.filePath);
    const form = new FormData();
    form.set('model', this.model);
    form.set(
      'file',
      new Blob([bytes], {
        type: input.mimeType ?? 'application/octet-stream',
      }),
      basename(input.filePath),
    );

    const response = await withTimeout(
      this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
      }),
      this.timeoutMs,
      'Transcription request timed out.',
    );

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(raw || 'Transcription request failed.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Transcription service returned invalid JSON.');
    }

    const text = (payload as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Transcription service did not return text.');
    }

    return text.trim();
  }
}

export function createConfiguredSpeechTranscriber(): SpeechTranscriber | null {
  loadLocalEnvFallback();
  const apiKey = stripWrappingQuotes(process.env.OPENAI_API_KEY?.trim());
  if (!apiKey) {
    return null;
  }

  const baseUrl =
    normalizeBaseUrl(stripWrappingQuotes(process.env.TRANSCRIPTION_BASE_URL?.trim())) ||
    normalizeBaseUrl(stripWrappingQuotes(process.env.OPENAI_BASE_URL?.trim())) ||
    DEFAULT_BASE_URL;
  const explicitModel =
    stripWrappingQuotes(process.env.TRANSCRIPTION_MODEL?.trim()) ||
    stripWrappingQuotes(process.env.OPENAI_TRANSCRIPTION_MODEL?.trim()) ||
    undefined;
  const model = resolveConfiguredTranscriptionModel({
    baseUrl,
    explicitModel,
  });

  return new OpenAICompatibleSpeechTranscriber({
    apiKey,
    model,
    baseUrl,
  });
}
