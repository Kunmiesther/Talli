import type { TalliService } from '../../app/talli-service.js';
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

export class TelegramConversationService {
  constructor(
    private readonly service: TalliService,
    public readonly transport: TelegramTransport,
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
      await this.transport.sendMessage(
        message.chat.id,
        'Voice notes are not enabled yet. Send text for now, or use the web app.',
      );
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
    });
    await this.transport.sendMessage(message.chat.id, response.message);
  }
}
