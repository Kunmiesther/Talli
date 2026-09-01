import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { TelegramConversationService } from '../src/integrations/telegram/telegram-service.js';
import type {
  TelegramFile,
  TelegramTransport,
  TelegramUpdate,
} from '../src/integrations/telegram/types.js';
import { MockSpeechTranscriber } from '../src/integrations/transcription/index.js';

const WEBHOOK_SECRET = 'webhook-secret';

class MemoryTelegramTransport implements TelegramTransport {
  public readonly messages: Array<{ chatId: number; text: string }> = [];
  public readonly getFileCalls: string[] = [];
  public readonly downloadFileCalls: string[] = [];

  constructor(private readonly voiceBytes = new Uint8Array([1, 2, 3])) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    this.getFileCalls.push(fileId);
    return { file_id: fileId, file_path: `${fileId}.ogg` };
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    this.downloadFileCalls.push(filePath);
    return this.voiceBytes;
  }
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
        username: `user_${input.telegramUserId}`,
      },
      text: input.text,
    },
  };
}

function voiceUpdate(input: {
  telegramUserId: number;
  fileId: string;
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
        username: `user_${input.telegramUserId}`,
      },
      voice: {
        file_id: input.fileId,
        duration: 12,
        mime_type: 'audio/ogg',
      },
    },
  };
}

async function createRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-webhook-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter: null });
  const transport = new MemoryTelegramTransport();
  const transcriber = new MockSpeechTranscriber(() => 'Sarah owes 120 dollars');
  const telegram = new TelegramConversationService(service, transport, transcriber, {
    tempDirRoot: join(dataDir, 'voice-temp'),
    maxVoiceFileBytes: 1024 * 1024,
  });

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

async function postWebhook(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  update: TelegramUpdate,
  secret = WEBHOOK_SECRET,
) {
  return handleTalliApiRequest(
    runtime.service,
    new Request('http://localhost/api/telegram/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secret,
      },
      body: JSON.stringify(update),
    }),
    {
      telegramConversation: runtime.telegram,
      telegramWebhookSecret: WEBHOOK_SECRET,
    },
  );
}

describe('Telegram webhook delivery', () => {
  it('links the correct user from /start link_<token> and marks the web session connected', async () => {
    const runtime = await createRuntime();

    try {
      const token = await runtime.service.createTelegramLinkToken('user-link');
      const response = await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 111,
          text: `/start link_${token.token}`,
        }),
      );

      expect(response.status).toBe(200);
      const storedToken = await runtime.store.getTelegramLinkToken(token.token);
      expect(storedToken?.consumedAt).not.toBeNull();
      expect(storedToken?.telegramUserId).toBe('111');
      expect(runtime.transport.messages.at(-1)?.text).toContain('Telegram connected');

      const linkStatusResponse = await handleTalliApiRequest(
        runtime.service,
        new Request(`http://localhost/api/auth/telegram/link-status?token=${token.token}`),
      );
      expect(linkStatusResponse.status).toBe(200);
      const setCookie = linkStatusResponse.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('talli_session=');

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
    } finally {
      await runtime.cleanup();
    }
  });

  it('consumes a link token exactly once and rejects invalid or expired tokens', async () => {
    const runtime = await createRuntime();

    try {
      const expired = await runtime.service.createTelegramLinkToken('expired-user', -1000);
      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 222,
          text: `/start link_${expired.token}`,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('no longer valid');

      const token = await runtime.service.createTelegramLinkToken('user-link');
      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 333,
          text: `/start link_${token.token}`,
        }),
      );
      const consumedOnce = await runtime.store.getTelegramLinkToken(token.token);
      expect(consumedOnce?.consumedAt).not.toBeNull();
      const firstWebSessionToken = consumedOnce?.webSessionToken;

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 333,
          text: `/start link_${token.token}`,
          messageId: 2,
        }),
      );
      const consumedTwice = await runtime.store.getTelegramLinkToken(token.token);
      expect(consumedTwice?.webSessionToken).toBe(firstWebSessionToken);
      expect(runtime.transport.messages.at(-1)?.text).toContain('no longer valid');
    } finally {
      await runtime.cleanup();
    }
  });

  it('handles plain /start, /balance, /customers, and normal text through the webhook', async () => {
    const runtime = await createRuntime();

    try {
      const token = await runtime.service.createTelegramLinkToken('user-ledger');
      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 444,
          text: `/start link_${token.token}`,
        }),
      );

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 444,
          text: 'Sarah owes 120 dollars',
          messageId: 2,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('Sarah now owes');

      const ledger = await runtime.service.getLedger('user-ledger');
      expect(ledger.customers[0]?.displayName).toBe('Sarah');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(12_000);

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 444,
          text: '/balance',
          messageId: 3,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('$120.00');

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 444,
          text: '/customers',
          messageId: 4,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('Sarah: $120.00');

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 444,
          text: '/help',
          messageId: 5,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('Send updates naturally');

      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 999,
          text: '/start',
          messageId: 6,
        }),
      );
      expect(runtime.transport.messages.at(-1)?.text).toContain('Welcome to Talli');
    } finally {
      await runtime.cleanup();
    }
  });

  it('routes voice notes through the existing transcription path', async () => {
    const runtime = await createRuntime();

    try {
      const token = await runtime.service.createTelegramLinkToken('user-voice');
      await postWebhook(
        runtime,
        messageUpdate({
          telegramUserId: 555,
          text: `/start link_${token.token}`,
        }),
      );

      await postWebhook(
        runtime,
        voiceUpdate({
          telegramUserId: 555,
          fileId: 'voice-1',
          messageId: 2,
        }),
      );

      expect(runtime.transport.getFileCalls).toEqual(['voice-1']);
      expect(runtime.transport.downloadFileCalls).toEqual(['voice-1.ogg']);
      expect(runtime.transport.messages.at(-1)?.text).toContain('Sarah now owes');
      const ledger = await runtime.service.getLedger('user-voice');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(12_000);
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects webhook requests with an invalid secret', async () => {
    const runtime = await createRuntime();

    try {
      const response = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/telegram/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': 'wrong-secret',
          },
          body: JSON.stringify(
            messageUpdate({
              telegramUserId: 666,
              text: '/start',
            }),
          ),
        }),
        {
          telegramConversation: runtime.telegram,
          telegramWebhookSecret: WEBHOOK_SECRET,
        },
      );

      expect(response.status).toBe(401);
      expect(runtime.transport.messages).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });
});
