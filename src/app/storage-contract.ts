import type { LedgerDocument, LedgerEvent } from '../domain/ledger.js';
import type {
  AuthState,
  LinkTokenRecord,
  LoadedSession,
  SessionState,
  TelegramLinkRecord,
  WebSessionRecord,
} from './storage.js';

export interface TalliStorageBackend {
  readonly defaultSessionId: string;
  readonly timezone: string;
  readonly turnHistoryLimit: number;
  load(sessionId?: string): Promise<LoadedSession>;
  save(session: {
    document: LedgerDocument;
    state: SessionState;
    ledgerPath: string;
    statePath: string;
  }): Promise<void>;
  saveState(statePath: string, state: SessionState): Promise<void>;
  appendEvents(ledgerPath: string, events: LedgerEvent[]): Promise<void>;
  replaceLedger(ledgerPath: string, document: LedgerDocument): Promise<void>;
  reset(sessionId?: string): Promise<void>;
  seed(
    seed: {
      document: LedgerDocument;
      state?: Partial<SessionState>;
    },
    sessionId?: string,
  ): Promise<void>;
  updateState(sessionId: string, updater: (state: SessionState) => SessionState): Promise<void>;
  clear(sessionId?: string): Promise<void>;
  getTelegramLink(telegramUserId: string): Promise<TelegramLinkRecord | null>;
  createTelegramLinkToken(options?: {
    sessionId?: string;
    ttlMs?: number;
  }): Promise<LinkTokenRecord>;
  getTelegramLinkToken(token: string): Promise<LinkTokenRecord | null>;
  consumeTelegramLinkToken(input: {
    token: string;
    telegramUserId: string;
    telegramUsername?: string | null;
  }): Promise<{ userId: string; webSessionToken: string } | null>;
  resolveWebSession(webSessionToken: string): Promise<string | null>;
  getWebSession(webSessionToken: string): Promise<WebSessionRecord | null>;
  getUserIdentity(sessionId: string): Promise<{
    userId: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
  }>;
  setPreferredCurrency(sessionId: string, currency: string): Promise<void>;
}

export interface TalliAuthStateEnvelope {
  auth: AuthState;
}
