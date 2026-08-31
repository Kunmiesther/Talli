import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { nairaToMinorUnits } from '../src/domain/money.js';
import { TelegramConversationService } from '../src/integrations/telegram/telegram-service.js';
import type {
  TelegramFile,
  TelegramTransport,
  TelegramUpdate,
} from '../src/integrations/telegram/types.js';

class MemoryTelegramTransport implements TelegramTransport {
  public readonly messages: Array<{ chatId: number; text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return { file_id: fileId, file_path: `${fileId}.ogg` };
  }

  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

async function tempRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-shared-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter: null });
  const transport = new MemoryTelegramTransport();
  const telegram = new TelegramConversationService(service, transport);
  return {
    dataDir,
    store,
    service,
    transport,
    telegram,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function messageUpdate(input: {
  telegramUserId: number;
  text: string;
  messageId?: number;
}): TelegramUpdate {
  return {
    update_id: input.messageId ?? 1,
    message: {
      message_id: input.messageId ?? 1,
      chat: {
        id: input.telegramUserId,
        type: 'private',
      },
      from: {
        id: input.telegramUserId,
        first_name: `User${input.telegramUserId}`,
      },
      text: input.text,
    },
  };
}

describe('shared Telegram and web state', () => {
  it('creates, expires, and consumes link tokens once', async () => {
    const runtime = await tempRuntime();
    const originalUsername = process.env.TELEGRAM_BOT_USERNAME;
    process.env.TELEGRAM_BOT_USERNAME = '@talli_bot';

    try {
      const expired = await runtime.service.createTelegramLinkToken('user-expired', -1000);
      expect(
        await runtime.service.consumeTelegramLinkToken({
          token: expired.token,
          telegramUserId: '111',
        }),
      ).toBeNull();

      const token = await runtime.service.createTelegramLinkToken('user-link');
      const consumed = await runtime.service.consumeTelegramLinkToken({
        token: token.token,
        telegramUserId: '222',
        telegramUsername: 'merchant',
      });
      expect(consumed).toMatchObject({ userId: 'user-link' });
      expect(
        await runtime.service.consumeTelegramLinkToken({
          token: token.token,
          telegramUserId: '222',
        }),
      ).toBeNull();

      const resolved = consumed
        ? await runtime.store.resolveWebSession(consumed.webSessionToken)
        : null;
      expect(resolved).toBe('user-link');

      const linkStatusResponse = await handleTalliApiRequest(
        runtime.service,
        new Request(`http://localhost/api/auth/telegram/link-status?token=${token.token}`),
      );
      const setCookie = linkStatusResponse.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');

      const meResponse = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/me', {
          headers: {
            cookie: setCookie.split(';')[0] ?? '',
          },
        }),
      );
      expect(await meResponse.json()).toMatchObject({
        ok: true,
        connected: true,
        userId: 'user-link',
      });

      const linkTokenResponse = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/auth/telegram/link-token', {
          method: 'POST',
        }),
      );
      const linkTokenBody = (await linkTokenResponse.json()) as {
        linkToken?: string;
        deepLink?: string;
      };
      expect(linkTokenBody.linkToken?.startsWith('link_')).toBe(false);
      expect(linkTokenBody.deepLink).toBe(
        `https://t.me/talli_bot?start=link_${linkTokenBody.linkToken}`,
      );
      expect(linkTokenBody.deepLink).not.toContain('link_link_');
    } finally {
      process.env.TELEGRAM_BOT_USERNAME = originalUsername;
      await runtime.cleanup();
    }
  });

  it('shares ledger state from Telegram to web and back', async () => {
    const runtime = await tempRuntime();

    try {
      const token = await runtime.service.createTelegramLinkToken('user-a');
      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 111,
          text: `/start link_${token.token}`,
        }),
      );

      const connected = await runtime.store.getTelegramLinkToken(token.token);
      expect(connected?.consumedAt).not.toBeNull();
      expect(connected?.webSessionToken).toBeTruthy();
      expect(runtime.transport.messages.at(-1)?.text).toContain('Telegram connected');

      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 111,
          text: 'Sarah owes 120 dollars',
          messageId: 2,
        }),
      );

      let ledger = await runtime.service.getLedger('user-a');
      expect(ledger.currency).toBe('USD');
      expect(ledger.customers[0]?.displayName).toBe('Sarah');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(12_000);

      await runtime.service.processMessage({
        text: 'Sarah paid 20',
        sessionId: 'user-a',
        language: 'en',
      });

      ledger = await runtime.service.getLedger('user-a');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(10_000);

      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 111,
          text: '/balance',
          messageId: 3,
        }),
      );

      expect(runtime.transport.messages.at(-1)?.text).toContain('$100.00');
    } finally {
      await runtime.cleanup();
    }
  });

  it('keeps linked Telegram users isolated', async () => {
    const runtime = await tempRuntime();

    try {
      const tokenA = await runtime.service.createTelegramLinkToken('user-a');
      const tokenB = await runtime.service.createTelegramLinkToken('user-b');

      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 101,
          text: `/start link_${tokenA.token}`,
        }),
      );
      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 202,
          text: `/start link_${tokenB.token}`,
        }),
      );

      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 101,
          text: 'Alice owes 50 dollars',
          messageId: 10,
        }),
      );

      const ledgerA = await runtime.service.getLedger('user-a');
      const ledgerB = await runtime.service.getLedger('user-b');
      expect(ledgerA.obligations[0]?.outstandingMinor).toBe(5_000);
      expect(ledgerB.obligations).toHaveLength(0);

      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 202,
          text: '/balance',
          messageId: 11,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('No open balance');

      await runtime.service.processMessage({
        text: 'Alice paid 10',
        sessionId: 'user-a',
        language: 'en',
      });

      const afterA = await runtime.service.getLedger('user-a');
      const afterB = await runtime.service.getLedger('user-b');
      expect(afterA.obligations[0]?.outstandingMinor).toBe(4_000);
      expect(afterB.obligations).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it('persists currency preference per user', async () => {
    const runtime = await tempRuntime();

    try {
      await runtime.service.setPreferredCurrency('user-currency', 'EUR');
      const reloaded = await runtime.store.load('user-currency');
      expect(reloaded.state.preferredCurrency).toBe('EUR');
      expect(reloaded.document.currency).toBe('EUR');
    } finally {
      await runtime.cleanup();
    }
  });

  it('blocks unknown Telegram users until they connect', async () => {
    const runtime = await tempRuntime();

    try {
      await runtime.telegram.handleUpdate(
        messageUpdate({
          telegramUserId: 303,
          text: '/balance',
          messageId: 1,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain(
        'Connect Telegram from Talli first',
      );
    } finally {
      await runtime.cleanup();
    }
  });
});
