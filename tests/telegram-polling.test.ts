import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { TelegramPollingBot } from '../src/integrations/telegram/polling-bot.js';
import { TelegramConversationService } from '../src/integrations/telegram/telegram-service.js';
import type {
  TelegramFile,
  TelegramTransport,
  TelegramUpdate,
} from '../src/integrations/telegram/types.js';

class QueueTelegramTransport implements TelegramTransport {
  public readonly offsets: Array<number | undefined> = [];
  public readonly messages: Array<{ chatId: number; text: string }> = [];

  constructor(private readonly updates: TelegramUpdate[]) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    if (this.updates.length === 0) {
      return [];
    }
    return this.updates.splice(0, this.updates.length);
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return { file_id: fileId, file_path: `${fileId}.ogg` };
  }

  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

function messageUpdate(text: string, telegramUserId = 111): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: {
        id: telegramUserId,
        type: 'private',
      },
      from: {
        id: telegramUserId,
        first_name: 'User',
      },
      text,
    },
  };
}

describe('Telegram polling', () => {
  it('still polls updates and forwards them through the shared conversation service', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-polling-'));
    const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
    const transport = new QueueTelegramTransport([messageUpdate('/start')]);
    const service = createTalliService({ store, interpreter: null });
    const conversation = new TelegramConversationService(service, transport);
    const bot = new TelegramPollingBot(conversation);

    try {
      const processed = await bot.pollOnce();
      expect(processed).toBe(1);
      expect(transport.offsets[0]).toBeUndefined();
      expect(transport.messages.at(-1)?.text).toContain('Welcome to Talli');

      const secondProcessed = await bot.pollOnce();
      expect(secondProcessed).toBe(0);
      expect(transport.offsets[1]).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
