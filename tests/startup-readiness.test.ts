import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalEnvFile, readRequiredEnv } from '../src/app/runtime-env.js';
import { createConfiguredTalliStore } from '../src/app/storage-factory.js';
import { SupabaseTalliSessionStore } from '../src/app/supabase-storage.js';
import { readTelegramBotRuntimeConfig } from '../src/integrations/telegram/config.js';

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

describe('startup readiness', () => {
  it('loads local .env files for process startup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-env-'));
    const envPath = join(dataDir, '.env');
    const snapshot = snapshotEnv(['TALLI_TEST_ENV_VALUE']);

    try {
      Reflect.deleteProperty(process.env, 'TALLI_TEST_ENV_VALUE');
      await writeFile(envPath, 'TALLI_TEST_ENV_VALUE="loaded from env"\n', 'utf8');

      loadLocalEnvFile(dataDir);

      expect(process.env.TALLI_TEST_ENV_VALUE).toBe('loaded from env');
    } finally {
      restoreEnv(snapshot);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails fast when SESSION_SECRET is missing', () => {
    const snapshot = snapshotEnv(['SESSION_SECRET']);

    try {
      Reflect.deleteProperty(process.env, 'SESSION_SECRET');
      expect(() =>
        readRequiredEnv('SESSION_SECRET', 'SESSION_SECRET is required to start the Talli API.'),
      ).toThrow('SESSION_SECRET is required to start the Talli API.');
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('activates Supabase storage only when the required config is present', () => {
    const snapshot = snapshotEnv([
      'TALLI_STORAGE_DRIVER',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);

    try {
      process.env.TALLI_STORAGE_DRIVER = 'supabase';
      Reflect.deleteProperty(process.env, 'SUPABASE_URL');
      Reflect.deleteProperty(process.env, 'SUPABASE_SERVICE_ROLE_KEY');

      expect(() => createConfiguredTalliStore()).toThrow(
        'TALLI_STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      );

      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

      const store = createConfiguredTalliStore();
      expect(store).toBeInstanceOf(SupabaseTalliSessionStore);
    } finally {
      restoreEnv(snapshot);
    }
  });

  it('requires a Telegram username when a Telegram bot token is configured', () => {
    const snapshot = snapshotEnv(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']);

    try {
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-bot-token';
      Reflect.deleteProperty(process.env, 'TELEGRAM_BOT_USERNAME');

      expect(() => readTelegramBotRuntimeConfig()).toThrow(
        'TELEGRAM_BOT_USERNAME is required when TELEGRAM_BOT_TOKEN is configured.',
      );

      process.env.TELEGRAM_BOT_USERNAME = '@UseTalliBot';
      expect(readTelegramBotRuntimeConfig()).toMatchObject({
        token: 'telegram-bot-token',
        username: 'UseTalliBot',
      });
    } finally {
      restoreEnv(snapshot);
    }
  });
});
