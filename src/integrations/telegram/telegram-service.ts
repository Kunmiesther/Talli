import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TalliService } from '../../app/talli-service.js';
import type { SpeechTranscriber } from '../transcription/speech-transcriber.js';
import type { TelegramMessage, TelegramTransport, TelegramUpdate } from './types.js';

function formatTelegramMoney(minorUnits: number, currency: string): string {
  const locale = currency === 'NGN' ? 'en-NG' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

function parseStartToken(text: string): string | null {
  const trimmed = text.trim();
  const match = /^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const payload = match[1]?.trim() ?? '';
  if (!payload.startsWith('link_')) {
    return null;
  }
  return payload.slice('link_'.length);
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase();
}

const DEFAULT_MAX_VOICE_FILE_BYTES = 20 * 1024 * 1024;
const SAFE_VOICE_DOWNLOAD_FAILURE_MESSAGE =
  "Talli couldn't read that voice note. Please try again or send it as text.";
const SAFE_VOICE_TRANSCRIPTION_FAILURE_MESSAGE =
  "Talli couldn't transcribe that voice note. Please try again or send the update as text.";
const SAFE_VOICE_TOO_LARGE_MESSAGE =
  'That voice note is too long. Please send a shorter voice note or type the update.';
const SAFE_VOICE_PROCESS_FAILURE_MESSAGE =
  "Talli couldn't process that voice note. Please try again or send the update as text.";

export interface TelegramVoiceHandlingOptions {
  tempDirRoot?: string;
  maxVoiceFileBytes?: number;
}

export class TelegramConversationService {
  constructor(
    private readonly service: TalliService,
    public readonly transport: TelegramTransport,
    private readonly transcriber: SpeechTranscriber | null = null,
    private readonly voiceOptions: TelegramVoiceHandlingOptions = {},
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || !message.from) {
      return;
    }

    if (message.text) {
      await this.handleTextMessage(message);
      return;
    }

    if (message.voice) {
      await this.handleVoiceMessage(message);
    }
  }

  private async handleVoiceMessage(message: TelegramMessage): Promise<void> {
    const from = message.from;
    const voice = message.voice;
    if (!from) {
      return;
    }
    if (!voice) {
      return;
    }

    const linked = await this.service.store.getTelegramLink(String(from.id));
    if (!linked) {
      await this.transport.sendMessage(
        message.chat.id,
        'Connect Telegram from Talli first, then send voice notes here.',
      );
      return;
    }

    if (!this.transcriber) {
      await this.transport.sendMessage(message.chat.id, SAFE_VOICE_TRANSCRIPTION_FAILURE_MESSAGE);
      return;
    }

    const maxVoiceFileBytes = this.voiceOptions.maxVoiceFileBytes ?? DEFAULT_MAX_VOICE_FILE_BYTES;
    const tempDirRoot = this.voiceOptions.tempDirRoot ?? tmpdir();
    let tempDir: string | null = null;
    let processingStage: 'download' | 'transcribe' | 'process' = 'download';

    try {
      if (voice.file_size !== undefined && voice.file_size > maxVoiceFileBytes) {
        await this.transport.sendMessage(message.chat.id, SAFE_VOICE_TOO_LARGE_MESSAGE);
        return;
      }

      const file = await this.transport.getFile(voice.file_id);
      if (!file.file_path) {
        await this.transport.sendMessage(message.chat.id, SAFE_VOICE_DOWNLOAD_FAILURE_MESSAGE);
        return;
      }

      const audioBytes = await this.transport.downloadFile(file.file_path);
      if (audioBytes.byteLength === 0 || audioBytes.byteLength > maxVoiceFileBytes) {
        await this.transport.sendMessage(message.chat.id, SAFE_VOICE_DOWNLOAD_FAILURE_MESSAGE);
        return;
      }

      await mkdir(tempDirRoot, { recursive: true });
      tempDir = await mkdtemp(join(tempDirRoot, 'talli-voice-'));
      const extension =
        voice.mime_type?.includes('ogg') || file.file_path.toLowerCase().endsWith('.ogg')
          ? '.ogg'
          : '.bin';
      const tempFilePath = join(tempDir, `${voice.file_id}${extension}`);
      await writeFile(tempFilePath, audioBytes);

      processingStage = 'transcribe';
      let transcript: string;
      try {
        transcript = (
          await this.transcriber.transcribe({
            filePath: tempFilePath,
            mimeType: voice.mime_type ?? undefined,
          })
        ).trim();
      } catch {
        await this.transport.sendMessage(message.chat.id, SAFE_VOICE_TRANSCRIPTION_FAILURE_MESSAGE);
        return;
      }

      if (!transcript) {
        await this.transport.sendMessage(message.chat.id, SAFE_VOICE_TRANSCRIPTION_FAILURE_MESSAGE);
        return;
      }

      processingStage = 'process';
      const response = await this.service.processMessage({
        text: transcript,
        sessionId: linked.userId,
        language: 'en',
        origin: 'telegram',
      });
      await this.transport.sendMessage(message.chat.id, response.message);
    } catch {
      await this.transport.sendMessage(
        message.chat.id,
        processingStage === 'process'
          ? SAFE_VOICE_PROCESS_FAILURE_MESSAGE
          : SAFE_VOICE_DOWNLOAD_FAILURE_MESSAGE,
      );
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  async handleTextMessage(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    const from = message.from;
    if (!text || !from) {
      return;
    }

    const startToken = parseStartToken(text);
    if (startToken) {
      const linked = await this.service.consumeTelegramLinkToken({
        token: startToken,
        telegramUserId: String(from.id),
        telegramUsername: from.username ?? null,
      });
      if (!linked) {
        await this.transport.sendMessage(
          message.chat.id,
          'That connection link is no longer valid. Please generate a new one from Talli.',
        );
        return;
      }

      await this.transport.sendMessage(
        message.chat.id,
        'Telegram connected. Open Talli on the web to see the same ledger.',
      );
      return;
    }

    const linked = await this.service.store.getTelegramLink(String(from.id));
    if (!linked) {
      await this.transport.sendMessage(
        message.chat.id,
        'Connect Telegram from Talli first, then send customer updates here.',
      );
      return;
    }

    const userId = linked.userId;
    const lower = normalizeCommand(text);
    if (lower === '/help') {
      await this.transport.sendMessage(
        message.chat.id,
        'Send updates naturally, or use /balance and /customers.',
      );
      return;
    }

    if (lower === '/balance') {
      const ledger = await this.service.getLedger(userId);
      const open = ledger.obligations.filter((entry) => entry.status === 'open');
      const total = ledger.totals.openOutstandingMinor;
      const currency = ledger.currency;
      const balanceText = open.length
        ? `Open balance: ${formatTelegramMoney(total, currency)} across ${open.length} obligation${open.length === 1 ? '' : 's'}.`
        : 'No open balance yet.';
      await this.transport.sendMessage(message.chat.id, balanceText);
      return;
    }

    if (lower === '/customers') {
      const ledger = await this.service.getLedger(userId);
      if (ledger.customers.length === 0) {
        await this.transport.sendMessage(message.chat.id, 'No customers yet.');
        return;
      }

      const lines = ledger.customers
        .slice()
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map((customer) => {
          const summary = ledger.obligations.filter((entry) => entry.customerId === customer.id);
          const outstanding = summary
            .filter((entry) => entry.status === 'open')
            .reduce((sum, entry) => sum + entry.outstandingMinor, 0);
          return `${customer.displayName}: ${formatTelegramMoney(outstanding, ledger.currency)}`;
        });
      await this.transport.sendMessage(message.chat.id, lines.join('\n'));
      return;
    }

    const response = await this.service.processMessage({
      text,
      sessionId: userId,
      language: 'en',
      origin: 'telegram',
    });
    await this.transport.sendMessage(message.chat.id, response.message);
  }
}
