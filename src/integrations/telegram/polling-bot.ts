import type { TelegramConversationService } from './telegram-service.js';
import type { TelegramUpdate } from './types.js';

export interface TelegramPollingOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export class TelegramPollingBot {
  private offset = 0;

  constructor(private readonly service: TelegramConversationService) {}

  async pollOnce(): Promise<number> {
    const updates = await this.service.transport.getUpdates(this.offset || undefined);
    let processed = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      await this.service.handleUpdate(update as TelegramUpdate);
      processed += 1;
    }
    return processed;
  }

  async start(options: TelegramPollingOptions = {}): Promise<void> {
    const intervalMs = options.pollIntervalMs ?? 2000;
    while (!options.signal?.aborted) {
      await this.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
