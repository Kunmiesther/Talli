import { readRequiredEnv } from '../../app/runtime-env.js';
import {
  buildTelegramWebhookUrl,
  readTelegramPublicUrl,
  readTelegramWebhookSecret,
} from './config.js';
import { TelegramBotApiTransport } from './http-transport.js';

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
  const info = await transport.getWebhookInfo();

  console.log(
    JSON.stringify(
      {
        ok: result,
        webhookUrl,
        secretConfigured: Boolean(secret),
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
