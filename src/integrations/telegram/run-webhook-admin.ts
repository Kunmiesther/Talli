import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredEnv } from '../../app/runtime-env.js';
import {
  buildTelegramWebhookUrl,
  readTelegramPublicUrl,
  readTelegramWebhookSecret,
} from './config.js';
import { TelegramBotApiTransport } from './http-transport.js';

export const TELEGRAM_COMMAND_MENU = [
  { command: 'start', description: 'Start Talli or connect your account' },
  { command: 'help', description: 'See how to use Talli' },
  { command: 'balance', description: 'View your outstanding credit summary' },
  { command: 'customers', description: 'View customers and their balances' },
] as const;

function readCommandArgument(name: string): string | null {
  const index = process.argv.findIndex((entry) => entry === name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1]?.trim();
  return value ? value : null;
}

async function setWebhook(): Promise<void> {
  const botToken = readRequiredEnv(
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN is required to register the Telegram webhook.',
  );
  const publicUrl =
    readCommandArgument('--public-url') ??
    readTelegramPublicUrl() ??
    process.env.RENDER_EXTERNAL_URL?.trim() ??
    null;

  if (!publicUrl) {
    throw new Error(
      'TALLI_PUBLIC_URL (or --public-url) is required to register the Telegram webhook.',
    );
  }

  const webhookUrl = buildTelegramWebhookUrl(publicUrl);
  const secret = readTelegramWebhookSecret();
  const transport = new TelegramBotApiTransport(botToken);
  const result = await transport.setWebhook(webhookUrl, secret);
  const commandsResult = await transport.setMyCommands(
    TELEGRAM_COMMAND_MENU.map((entry) => ({ ...entry })),
  );
  const info = await transport.getWebhookInfo();

  console.log(
    JSON.stringify(
      {
        ok: result,
        commandsOk: commandsResult,
        webhookUrl,
        secretConfigured: Boolean(secret),
        commands: TELEGRAM_COMMAND_MENU,
        webhookInfo: info,
      },
      null,
      2,
    ),
  );
}

async function printWebhookInfo(): Promise<void> {
  const botToken = readRequiredEnv(
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_TOKEN is required to inspect Telegram webhook status.',
  );
  const transport = new TelegramBotApiTransport(botToken);
  const info = await transport.getWebhookInfo();
  console.log(JSON.stringify(info, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === 'set') {
    await setWebhook();
    return;
  }
  if (command === 'info') {
    await printWebhookInfo();
    return;
  }

  throw new Error('Usage: tsx src/integrations/telegram/run-webhook-admin.ts <set|info>');
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
