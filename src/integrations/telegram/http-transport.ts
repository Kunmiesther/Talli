import type { TelegramFile, TelegramTransport, TelegramUpdate } from './types.js';

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export class TelegramBotApiTransport implements TelegramTransport {
  constructor(
    private readonly botToken: string,
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  private get apiBase(): string {
    return trimTrailingSlash(this.baseUrl);
  }

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callApi<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.apiBase}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : '{}',
    });
    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description ?? `Telegram API request failed for ${method}.`);
    }
    return payload.result;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.callApi('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: 0,
      allowed_updates: ['message'],
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.callApi<TelegramFile>('getFile', { file_id: fileId });
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(
      `${this.apiBase}/file/bot${this.botToken}/${filePath}`,
      {},
    );
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file ${filePath}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
