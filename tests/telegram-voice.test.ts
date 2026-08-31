import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TalliSessionStore, createDefaultSessionState } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { createLedgerDocument } from '../src/domain/ledger.js';
import { TelegramConversationService } from '../src/integrations/telegram/telegram-service.js';
import type {
  TelegramFile,
  TelegramTransport,
  TelegramUpdate,
} from '../src/integrations/telegram/types.js';
import { MockSpeechTranscriber } from '../src/integrations/transcription/index.js';
import type { SpeechTranscriptionInput } from '../src/integrations/transcription/index.js';

class MemoryTelegramTransport implements TelegramTransport {
  public readonly messages: Array<{ chatId: number; text: string }> = [];
  public readonly getFileCalls: string[] = [];
  public readonly downloadFileCalls: string[] = [];

  constructor(
    private readonly options: {
      voiceBytes?: Uint8Array;
      downloadError?: Error;
    } = {},
  ) {}

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
    if (this.options.downloadError) {
      throw this.options.downloadError;
    }
    return this.options.voiceBytes ?? new Uint8Array([1, 2, 3]);
  }
}

function voiceUpdate(input: {
  telegramUserId: number;
  fileId: string;
  fileSize?: number;
  duration?: number;
  mimeType?: string;
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
        file_size: input.fileSize,
        duration: input.duration,
        mime_type: input.mimeType,
      },
    },
  };
}

async function createRuntime(
  transcriber: MockSpeechTranscriber,
  transport: MemoryTelegramTransport,
  options: {
    tempDirRoot?: string;
    linkedSessionId?: string;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-voice-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter: null });
  const telegram = new TelegramConversationService(service, transport, transcriber, {
    tempDirRoot: options.tempDirRoot ?? join(dataDir, 'voice-temp'),
    maxVoiceFileBytes: 1024 * 1024,
  });

  const sessionId = options.linkedSessionId ?? 'voice-user';
  const token = await service.createTelegramLinkToken(sessionId);
  const linked = await service.consumeTelegramLinkToken({
    token: token.token,
    telegramUserId: '777',
    telegramUsername: 'merchant_voice',
  });
  if (!linked) {
    throw new Error('Expected Telegram linking to succeed.');
  }

  return {
    dataDir,
    store,
    service,
    transport,
    telegram,
    linkedSessionId: linked.userId,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe('Telegram voice notes', () => {
  it('downloads, transcribes, and mutates through the shared TalliService', async () => {
    const transport = new MemoryTelegramTransport();
    let seenFilePath: string | null = null;
    let seenMimeType: string | undefined;
    let fileExistedDuringTranscription = false;
    const transcriber = new MockSpeechTranscriber((input: SpeechTranscriptionInput) => {
      seenFilePath = input.filePath;
      seenMimeType = input.mimeType;
      fileExistedDuringTranscription = existsSync(input.filePath);
      return 'Sarah owes 120 dollars';
    });
    const runtime = await createRuntime(transcriber, transport);

    try {
      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 777,
          fileId: 'voice-1',
          duration: 12,
          fileSize: 42,
          mimeType: 'audio/ogg',
          messageId: 1,
        }),
      );

      expect(transport.getFileCalls).toEqual(['voice-1']);
      expect(transport.downloadFileCalls).toEqual(['voice-1.ogg']);
      expect(transcriber.calls).toHaveLength(1);
      expect(fileExistedDuringTranscription).toBe(true);
      expect(seenMimeType).toBe('audio/ogg');
      expect(seenFilePath).toBeTruthy();
      expect(runtime.transport.messages.at(-1)?.text).toBe('Sarah now owes $120.00.');

      const ledger = await runtime.service.getLedger(runtime.linkedSessionId);
      expect(ledger.currency).toBe('USD');
      expect(ledger.customers[0]?.displayName).toBe('Sarah');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(12_000);

      expect(seenFilePath).toBeTruthy();
      if (seenFilePath) {
        expect(existsSync(seenFilePath)).toBe(false);
      }
      const tempRoot = join(runtime.dataDir, 'voice-temp');
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await runtime.cleanup();
    }
  });

  it('keeps ambiguity handling on the same clarification path', async () => {
    const transport = new MemoryTelegramTransport();
    const transcriber = new MockSpeechTranscriber(() => 'Sarah paid 20');
    const runtime = await createRuntime(transcriber, transport);

    try {
      const document = createLedgerDocument(runtime.linkedSessionId, 'USD');
      document.events = [
        {
          id: 'customer-a',
          kind: 'customer.created',
          timestamp: '2026-08-30T10:00:00.000Z',
          actor: 'system',
          customerId: 'customer-a',
          displayName: 'Sarah',
          aliases: [],
        },
        {
          id: 'customer-b',
          kind: 'customer.created',
          timestamp: '2026-08-30T10:01:00.000Z',
          actor: 'system',
          customerId: 'customer-b',
          displayName: 'Sarah',
          aliases: [],
        },
        {
          id: 'obligation-a',
          kind: 'obligation.created',
          timestamp: '2026-08-30T10:02:00.000Z',
          actor: 'system',
          customerId: 'customer-a',
          obligationId: 'obligation-a',
          originalAmountMinor: 12_000,
          dueAt: null,
        },
        {
          id: 'obligation-b',
          kind: 'obligation.created',
          timestamp: '2026-08-30T10:03:00.000Z',
          actor: 'system',
          customerId: 'customer-b',
          obligationId: 'obligation-b',
          originalAmountMinor: 14_000,
          dueAt: null,
        },
      ];
      await runtime.store.seed(
        {
          document,
          state: {
            ...createDefaultSessionState(runtime.linkedSessionId, runtime.store.timezone),
            userId: runtime.linkedSessionId,
            ledgerId: runtime.linkedSessionId,
            ledgerCurrency: 'USD',
            preferredCurrency: 'USD',
          },
        },
        runtime.linkedSessionId,
      );

      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 777,
          fileId: 'voice-clarify',
          duration: 8,
          fileSize: 42,
          mimeType: 'audio/ogg',
          messageId: 2,
        }),
      );

      const loaded = await runtime.store.load(runtime.linkedSessionId);
      expect(loaded.state.pendingClarification).not.toBeNull();
      expect(loaded.document.events.length).toBeGreaterThanOrEqual(4);
      expect(runtime.transport.messages.at(-1)?.text).toContain('Which customer did you mean?');
    } finally {
      await runtime.cleanup();
    }
  });

  it('fails safely when audio download fails', async () => {
    const transport = new MemoryTelegramTransport({
      downloadError: new Error('download failed'),
    });
    const transcriber = new MockSpeechTranscriber(() => 'should not be used');
    const runtime = await createRuntime(transcriber, transport);

    try {
      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 777,
          fileId: 'voice-download-fail',
          duration: 10,
          fileSize: 42,
          mimeType: 'audio/ogg',
          messageId: 3,
        }),
      );

      expect(transcriber.calls).toHaveLength(0);
      expect(runtime.transport.messages.at(-1)?.text).toBe(
        "Talli couldn't read that voice note. Please try again or send it as text.",
      );
      const ledger = await runtime.service.getLedger(runtime.linkedSessionId);
      expect(ledger.obligations).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it('fails safely when transcription fails and cleans temporary files', async () => {
    const transport = new MemoryTelegramTransport();
    const transcriber = new MockSpeechTranscriber(() => {
      throw new Error('transcription failed');
    });
    const runtime = await createRuntime(transcriber, transport);

    try {
      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 777,
          fileId: 'voice-transcribe-fail',
          duration: 10,
          fileSize: 42,
          mimeType: 'audio/ogg',
          messageId: 4,
        }),
      );

      expect(runtime.transport.messages.at(-1)?.text).toBe(
        "Talli couldn't transcribe that voice note. Please try again or send the update as text.",
      );
      expect(transcriber.calls).toHaveLength(1);
      expect(await readdir(join(runtime.dataDir, 'voice-temp'))).toEqual([]);
      const ledger = await runtime.service.getLedger(runtime.linkedSessionId);
      expect(ledger.obligations).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it('rejects voice notes that exceed the configured size limit before transcription', async () => {
    const transport = new MemoryTelegramTransport();
    const transcriber = new MockSpeechTranscriber(() => 'should not be used');
    const runtime = await createRuntime(transcriber, transport);

    try {
      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 777,
          fileId: 'voice-too-large',
          duration: 10,
          fileSize: 2 * 1024 * 1024,
          mimeType: 'audio/ogg',
          messageId: 5,
        }),
      );

      expect(transcriber.calls).toHaveLength(0);
      expect(transport.getFileCalls).toHaveLength(0);
      expect(runtime.transport.messages.at(-1)?.text).toBe(
        'That voice note is too long. Please send a shorter voice note or type the update.',
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it('blocks unlinked users from voice ingestion', async () => {
    const transport = new MemoryTelegramTransport();
    const transcriber = new MockSpeechTranscriber(() => 'Sarah owes 120 dollars');
    const runtime = await createRuntime(transcriber, transport);

    try {
      await runtime.telegram.handleUpdate(
        voiceUpdate({
          telegramUserId: 888,
          fileId: 'voice-unlinked',
          duration: 10,
          fileSize: 42,
          mimeType: 'audio/ogg',
          messageId: 6,
        }),
      );

      expect(runtime.transport.messages.at(-1)?.text).toContain('Connect Telegram from Talli');
      expect(transcriber.calls).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });
});
