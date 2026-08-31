import type { TalliStorageBackend } from './storage-contract.js';
import { TalliSessionStore, type TalliStorageOptions } from './storage.js';
import { SupabaseTalliSessionStore } from './supabase-storage.js';

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

export function createConfiguredTalliStore(options: TalliStorageOptions = {}): TalliStorageBackend {
  const driver = envValue(process.env.TALLI_STORAGE_DRIVER)?.toLowerCase();
  if (driver === 'supabase') {
    const supabaseUrl = envValue(process.env.SUPABASE_URL);
    const serviceRoleKey = envValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        'TALLI_STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }

    return new SupabaseTalliSessionStore({
      supabaseUrl,
      supabaseServiceRoleKey: serviceRoleKey,
      defaultSessionId: options.defaultSessionId,
      timezone: options.timezone,
      turnHistoryLimit: options.turnHistoryLimit,
    });
  }

  return new TalliSessionStore(options);
}
