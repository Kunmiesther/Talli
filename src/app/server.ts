import { readTelegramBotRuntimeConfig } from '../integrations/telegram/config.js';
import { TelegramBotApiTransport } from '../integrations/telegram/http-transport.js';
import { TelegramConversationService } from '../integrations/telegram/telegram-service.js';
import { createConfiguredSpeechTranscriber } from '../integrations/transcription/speech-transcriber.js';
import { createTalliHttpServer } from './api.js';
import { loadLocalEnvFile, readRequiredEnv } from './runtime-env.js';
import { createTalliService } from './talli-service.js';

function readHost(): string {
  return process.env.TALLI_HOST ?? process.env.HOST ?? '0.0.0.0';
}

function readPort(): number {
  const raw = process.env.TALLI_PORT ?? process.env.PORT ?? '3000';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3000;
  }
  return Math.trunc(parsed);
}

async function main() {
  loadLocalEnvFile();
  readRequiredEnv('SESSION_SECRET', 'SESSION_SECRET is required to start the Talli API.');
  const telegramRuntimeConfig = readTelegramBotRuntimeConfig();
  const telegramTransport = telegramRuntimeConfig
    ? new TelegramBotApiTransport(telegramRuntimeConfig.token)
    : null;
  const telegramNotifier = telegramTransport;
  const service = createTalliService({ telegramNotifier });
  const telegramConversation = telegramTransport
    ? new TelegramConversationService(
        service,
        telegramTransport,
        createConfiguredSpeechTranscriber(),
      )
    : null;
  const host = readHost();
  const port = readPort();
  const server = createTalliHttpServer(service, port, {
    telegramConversation,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  console.log(`Talli API listening on ${host}:${port}`);
  console.log(`Model available: ${service.interpreter ? 'yes' : 'no'}`);
  if (telegramRuntimeConfig) {
    console.log(`Telegram bot username: @${telegramRuntimeConfig.username}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
