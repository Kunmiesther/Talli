import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loadedLocalEnv = false;

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

export function loadLocalEnvFile(baseDir = process.cwd()): void {
  if (loadedLocalEnv) {
    return;
  }
  loadedLocalEnv = true;

  const envPath = resolve(baseDir, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  const initiallyConfiguredKeys = new Set(Object.keys(process.env));
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || initiallyConfiguredKeys.has(key)) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue) ?? rawValue;
  }
}

export function readRequiredEnv(name: string, message: string): string {
  loadLocalEnvFile();
  const value = stripWrappingQuotes(process.env[name]?.trim());
  if (!value) {
    throw new Error(message);
  }
  return value;
}
