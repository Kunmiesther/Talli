import { loadLocalEnvFile } from '../../app/runtime-env.js';

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

function envValue(value: string | undefined): string | undefined {
  const trimmed = stripWrappingQuotes(value?.trim());
  return trimmed?.length ? trimmed : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeTelegramUsername(value: string | null | undefined): string | null {
  const normalized = envValue(value ?? undefined);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/^@+/, '');
}

export function readTelegramBotRuntimeConfig(): {
  token: string;
  username: string;
} | null {
  loadLocalEnvFile();
  const token = envValue(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) {
    return null;
  }

  const username = normalizeTelegramUsername(process.env.TELEGRAM_BOT_USERNAME);
  if (!username) {
    throw new Error('TELEGRAM_BOT_USERNAME is required when TELEGRAM_BOT_TOKEN is configured.');
  }

  return {
    token,
    username,
  };
}

export function readTelegramWebhookSecret(): string | null {
  loadLocalEnvFile();
  return envValue(process.env.TELEGRAM_WEBHOOK_SECRET) ?? null;
}

export function readTelegramPublicUrl(): string | null {
  loadLocalEnvFile();
  return envValue(process.env.TALLI_PUBLIC_URL) ?? null;
}

export function buildTelegramDeepLink(
  botUsername: string | null | undefined,
  token: string,
): string {
  const username = normalizeTelegramUsername(botUsername);
  return username
    ? `https://t.me/${username}?start=link_${token}`
    : `https://t.me/?start=link_${token}`;
}

export function buildTelegramWebhookUrl(publicUrl: string): string {
  return `${trimTrailingSlash(publicUrl)}/api/telegram/webhook`;
}
