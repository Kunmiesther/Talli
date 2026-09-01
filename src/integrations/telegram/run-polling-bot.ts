import { createTalliService } from '../../app/talli-service.js';
import { createConfiguredSpeechTranscriber } from '../transcription/speech-transcriber.js';
import { readTelegramBotRuntimeConfig } from './config.js';
import { TelegramBotApiTransport } from './http-transport.js';
import { TelegramPollingBot } from './polling-bot.js';
import { TelegramConversationService } from './telegram-service.js';

function readTelegramConfig(): { token: string; username: string } {
  const config = readTelegramBotRuntimeConfig();
  if (!config) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to run the Telegram polling bot.');
  }
  return config;
}

async function main() {
  const { token: botToken, username: botUsername } = readTelegramConfig();
  const service = createTalliService();
  const transport = new TelegramBotApiTransport(botToken);
  const transcriber = createConfiguredSpeechTranscriber();
  const conversation = new TelegramConversationService(service, transport, transcriber);
  const bot = new TelegramPollingBot(conversation);

  console.log('Talli Telegram polling bot starting...');
  console.log(`Telegram bot username: @${botUsername}`);
  console.log(`Voice transcription: ${transcriber ? 'enabled' : 'disabled'}`);
  await bot.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
