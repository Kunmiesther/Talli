import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { type TalliServiceOptions, createTalliService } from '../src/app/talli-service.js';
import { ledgerActionSchema } from '../src/domain/actions.js';
import { type LedgerEvent, createLedgerDocument } from '../src/domain/ledger.js';
import { formatMinorUnits, formatNgn, nairaToMinorUnits } from '../src/domain/money.js';
import type { ActionInterpreter, AdvancedInterpreterInput } from '../src/interpreters.js';
import type { StructuredActionModelDiagnostics } from '../src/llm/structured-action-model.js';

const baseDiagnostics: StructuredActionModelDiagnostics = {
  provider: 'mock',
  model: 'mock',
  baseUrl: 'mock',
  configured: true,
  contractName: 'LedgerIntent',
  contractVersion: 'test',
  attempts: 1,
  latencyMs: 1,
  responseFormatUsed: true,
  rawOutputs: ['{}'],
  parseErrors: [],
  requestIds: [],
  attemptLogs: [],
  rateLimitFailures: 0,
  schemaInvalidResponses: 0,
  providerFailures: 0,
};

function makeAction(action: Parameters<typeof ledgerActionSchema.parse>[0]) {
  return ledgerActionSchema.parse(action);
}

class ScriptedInterpreter implements ActionInterpreter {
  readonly kind = 'advanced' as const;
  public lastInput: AdvancedInterpreterInput | null = null;
  public lastDiagnostics = {
    mode: 'advanced' as const,
    promptKind: 'advanced' as const,
    provider: baseDiagnostics,
    clock: {
      referenceNow: '2026-08-29T09:00:00+01:00',
      timezone: 'Africa/Lagos',
    },
    inputText: '',
    language: 'en' as 'en' | 'pcm' | 'mixed',
    modelIntent: null,
    compiler: null,
  };

  constructor(private readonly actions: Array<ReturnType<typeof ledgerActionSchema.parse>>) {}

  async interpret(input: Parameters<ActionInterpreter['interpret']>[0]) {
    this.lastInput = input as AdvancedInterpreterInput;
    this.lastDiagnostics = {
      ...this.lastDiagnostics,
      inputText: input.text,
      language: (input.language ?? 'en') as 'en' | 'pcm' | 'mixed',
    };
    return (
      this.actions.shift() ??
      makeAction({ type: 'NO_ACTION', reason: 'fallback', evidence: [], permittedMutation: false })
    );
  }
}

class RecordingTelegramNotifier {
  public readonly messages: Array<{ chatId: number; text: string }> = [];
  public failNextSend = false;

  async sendMessage(chatId: number, text: string): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('telegram send failed');
    }
    this.messages.push({ chatId, text });
  }
}

async function tempService(
  interpreter: ActionInterpreter | null = null,
  options: Pick<TalliServiceOptions, 'telegramNotifier'> = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-runtime-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter, ...options });
  return {
    dataDir,
    store,
    service,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function createCustomerEvent(input: {
  id: string;
  displayName: string;
  timestamp: string;
}): LedgerEvent {
  return {
    id: `${input.id}:created`,
    kind: 'customer.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.id,
    displayName: input.displayName,
    aliases: [],
  };
}

function createObligationEvent(input: {
  id: string;
  customerId: string;
  amountMinor: number;
  timestamp: string;
  dueAt?: string | null;
}): LedgerEvent {
  return {
    id: `${input.id}:created`,
    kind: 'obligation.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    obligationId: input.id,
    originalAmountMinor: input.amountMinor,
    dueAt: input.dueAt ?? null,
  };
}

function seedManualLedger(
  runtime: Awaited<ReturnType<typeof tempService>>,
  events: LedgerEvent[],
  currency = 'USD',
) {
  const document = createLedgerDocument('demo');
  document.currency = currency;
  document.events = [...events];
  return runtime.store.seed(
    {
      document,
      state: {
        ledgerCurrency: currency,
        preferredCurrency: currency,
      },
    },
    'demo',
  );
}

describe('Talli application runtime', () => {
  it('creates an obligation and persists it across service reload', async () => {
    const runtime = await tempService(
      new ScriptedInterpreter([
        makeAction({
          type: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Mama Tobi', aliases: ['Tobi'] },
          amountMinor: nairaToMinorUnits(50_000),
          dueAt: '2026-08-31T00:00:00.000Z',
          permittedMutation: true,
          evidence: ['Mama Tobi took 50k goods yesterday.'],
          source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'pcm' },
        }),
      ]),
    );

    try {
      const response = await runtime.service.processMessage({
        text: 'Mama Tobi took 50k goods yesterday.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'pcm',
      });

      expect(response.status).toBe('applied');
      expect(response.message).toContain(
        `Mama Tobi now owes ${formatNgn(nairaToMinorUnits(50_000))}`,
      );

      const reloaded = createTalliService({
        store: new TalliSessionStore({ dataDir: runtime.dataDir, defaultSessionId: 'demo' }),
        interpreter: null,
      });
      const ledger = await reloaded.getLedger('demo');
      expect(ledger.customers).toHaveLength(1);
      expect(ledger.obligations).toHaveLength(1);
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(50_000));
    } finally {
      await runtime.cleanup();
    }
  });

  it('persists a partial payment and renders the remaining balance from final state', async () => {
    const runtime = await tempService(
      new ScriptedInterpreter([
        makeAction({
          type: 'RECORD_PAYMENT',
          customer: { kind: 'name', name: 'Mama Tobi', allowCreate: false },
          obligation: {
            kind: 'latestOpenForCustomer',
            customer: { kind: 'name', name: 'Mama Tobi', allowCreate: false },
          },
          amountMinor: nairaToMinorUnits(20_000),
          settleRemaining: false,
          permittedMutation: true,
          evidence: ['Mama Tobi brought 20k.'],
          source: { utterance: 'Mama Tobi brought 20k.', language: 'pcm' },
        }),
      ]),
    );

    try {
      await runtime.service.seedDemoLedger('demo');
      const response = await runtime.service.processMessage({
        text: 'Mama Tobi brought 20k.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'pcm',
      });

      expect(response.status).toBe('applied');
      expect(response.message).toContain(formatNgn(nairaToMinorUnits(20_000)));
      expect(response.message).toContain(`${formatNgn(nairaToMinorUnits(10_000))} remains`);

      const ledger = await runtime.service.getLedger('demo');
      expect(
        ledger.obligations.some((entry) => entry.outstandingMinor === nairaToMinorUnits(10_000)),
      ).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });

  it('persists corrections and recomputes the outstanding balance', async () => {
    const runtime = await tempService(
      new ScriptedInterpreter([
        makeAction({
          type: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Kemi', aliases: [] },
          amountMinor: nairaToMinorUnits(24_000),
          permittedMutation: true,
          evidence: ['Kemi took 24 thousand worth of goods.'],
          source: { utterance: 'Kemi took 24 thousand worth of goods.', language: 'en' },
        }),
        makeAction({
          type: 'RECORD_PAYMENT',
          customer: { kind: 'name', name: 'Kemi', allowCreate: false },
          obligation: {
            kind: 'latestOpenForCustomer',
            customer: { kind: 'name', name: 'Kemi', allowCreate: false },
          },
          amountMinor: nairaToMinorUnits(4_000),
          settleRemaining: false,
          permittedMutation: true,
          evidence: ['Kemi brought 4k.'],
          source: { utterance: 'Kemi brought 4k.', language: 'en' },
        }),
        makeAction({
          type: 'CORRECT_OBLIGATION',
          obligation: {
            kind: 'latestOpenForCustomer',
            customer: { kind: 'name', name: 'Kemi', allowCreate: false },
          },
          correctedAmountMinor: nairaToMinorUnits(42_000),
          correctionReason: 'Customer clarified the original amount.',
          permittedMutation: true,
          evidence: ['That Kemi money, it was 42 thousand.'],
          source: { utterance: 'That Kemi money, it was 42 thousand.', language: 'en' },
        }),
      ]),
    );

    try {
      await runtime.service.resetDemoLedger('demo');
      await runtime.service.processMessage({
        text: 'Ledger turn one.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });
      await runtime.service.processMessage({
        text: 'Ledger turn two.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      const response = await runtime.service.processMessage({
        text: 'Ledger turn three.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('applied');
      expect(response.message).toContain(
        `${formatNgn(nairaToMinorUnits(24_000))} to ${formatNgn(nairaToMinorUnits(42_000))}`,
      );
      expect(response.message).toContain(formatNgn(nairaToMinorUnits(38_000)));

      const ledger = await runtime.service.getLedger('demo');
      expect(
        ledger.obligations.some((entry) => entry.originalAmountMinor === nairaToMinorUnits(42_000)),
      ).toBe(true);
      expect(
        ledger.obligations.some((entry) => entry.outstandingMinor === nairaToMinorUnits(38_000)),
      ).toBe(true);
    } finally {
      await runtime.cleanup();
    }
  });

  it('processes explicit customer and amount phrases without a model provider', async () => {
    const runtime = await tempService(null);

    try {
      const created = await runtime.service.processMessage({
        text: 'Bisi owes 5k',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(created.status).toBe('applied');
      expect(created.message).toContain('Bisi now owes');
      expect(created.message).toContain(formatNgn(nairaToMinorUnits(5_000)));

      let ledger = await runtime.service.getLedger('demo');
      expect(ledger.currency).toBe('NGN');
      expect(ledger.customers).toHaveLength(1);
      expect(ledger.customers[0]?.displayName).toBe('Bisi');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(5_000));

      const paid = await runtime.service.processMessage({
        text: 'Bisi paid 2k',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(paid.status).toBe('applied');
      expect(paid.message).toContain(formatNgn(nairaToMinorUnits(2_000)));
      expect(paid.message).toContain(`${formatNgn(nairaToMinorUnits(3_000))} remains`);

      ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(3_000));

      const corrected = await runtime.service.processMessage({
        text: 'Actually Bisi owes 4k, not 5k',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(corrected.status).toBe('applied');
      expect(corrected.message).toContain(formatNgn(nairaToMinorUnits(4_000)));

      ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.originalAmountMinor).toBe(nairaToMinorUnits(4_000));
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(2_000));
    } finally {
      await runtime.cleanup();
    }
  });

  it('processes explicit currency updates and clarifies on currency conflicts', async () => {
    const runtime = await tempService(null);

    try {
      const created = await runtime.service.processMessage({
        text: 'Sarah owes 200 dollars',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(created.status).toBe('applied');
      expect(created.message).toContain(formatMinorUnits(20_000, 'USD'));

      let ledger = await runtime.service.getLedger('demo');
      expect(ledger.currency).toBe('USD');
      expect(ledger.customers[0]?.displayName).toBe('Sarah');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(20_000);

      const paid = await runtime.service.processMessage({
        text: 'Sarah paid 50',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(paid.status).toBe('applied');
      expect(paid.message).toContain(formatMinorUnits(5_000, 'USD'));
      expect(paid.message).toContain(`${formatMinorUnits(15_000, 'USD')} remains`);

      ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(15_000);

      const corrected = await runtime.service.processMessage({
        text: 'Actually Sarah owes 180, not 200',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(corrected.status).toBe('applied');
      expect(corrected.message).toContain(formatMinorUnits(18_000, 'USD'));
      expect(corrected.message).toContain(formatMinorUnits(13_000, 'USD'));

      ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.originalAmountMinor).toBe(18_000);
      expect(ledger.obligations[0]?.outstandingMinor).toBe(13_000);

      const beforeConflict = await runtime.service.getLedger('demo');
      const conflict = await runtime.service.processMessage({
        text: 'James owes 10 pounds',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(conflict.status).toBe('clarification_required');
      expect(conflict.message).toContain('currently using USD');

      const afterConflict = await runtime.service.getLedger('demo');
      expect(afterConflict).toEqual(beforeConflict);
    } finally {
      await runtime.cleanup();
    }
  });

  it('settles a full payment when the amount exactly matches the remaining balance', async () => {
    const runtime = await tempService(null);

    try {
      await runtime.service.processMessage({
        text: 'Sarah owes 200 dollars',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      const response = await runtime.service.processMessage({
        text: 'Sarah has paid back the $200',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('applied');
      expect(response.message.toLowerCase()).toContain('settled');

      const ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations).toHaveLength(1);
      expect(ledger.obligations[0]?.status).toBe('settled');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(0);
      expect(ledger.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(200));
      expect(ledger.obligations[0]?.paymentEventIds).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it('records a partial payment when the payment is smaller than the balance', async () => {
    const runtime = await tempService(null);

    try {
      await runtime.service.processMessage({
        text: 'Sarah owes 200 dollars',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      const response = await runtime.service.processMessage({
        text: 'Sarah paid $50',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('applied');
      expect(response.message).toContain(formatMinorUnits(15_000, 'USD'));

      const ledger = await runtime.service.getLedger('demo');
      expect(ledger.obligations[0]?.status).toBe('open');
      expect(ledger.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(150));
      expect(ledger.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(50));
      expect(ledger.obligations[0]?.paymentEventIds).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it('creates a new obligation from ordinary owing language and stores the due date', async () => {
    const runtime = await tempService(null);

    try {
      const response = await runtime.service.processMessage({
        text: 'James is owing 500 dollars and will pay on Friday',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('applied');
      expect(response.message).toContain('James now owes');
      expect(response.message).toContain('Due Friday');

      const ledger = await runtime.service.getLedger('demo');
      expect(ledger.customers).toHaveLength(1);
      expect(ledger.customers[0]?.displayName).toBe('James');
      expect(ledger.obligations[0]?.originalAmountMinor).toBe(nairaToMinorUnits(500));
      expect(ledger.obligations[0]?.dueAt).toBe(
        new Date('2026-09-04T00:00:00+01:00').toISOString(),
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it('asks for clarification when the customer name is ambiguous', async () => {
    const runtime = await tempService(null);

    try {
      await seedManualLedger(runtime, [
        createCustomerEvent({
          id: 'customer-sarah-a',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        createCustomerEvent({
          id: 'customer-sarah-b',
          displayName: 'Sarah',
          timestamp: '2026-08-30T09:00:00.000Z',
        }),
      ]);

      const before = await runtime.service.getLedger('demo');
      const response = await runtime.service.processMessage({
        text: 'Sarah paid $50',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('clarification_required');
      expect(await runtime.service.getLedger('demo')).toEqual(before);
    } finally {
      await runtime.cleanup();
    }
  });

  it('asks for clarification when multiple open obligations exist for one customer', async () => {
    const runtime = await tempService(null);

    try {
      await seedManualLedger(runtime, [
        createCustomerEvent({
          id: 'customer-sarah',
          displayName: 'Sarah',
          timestamp: '2026-08-30T08:00:00.000Z',
        }),
        createObligationEvent({
          id: 'obligation-sarah-1',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(120),
          timestamp: '2026-08-30T08:30:00.000Z',
        }),
        createObligationEvent({
          id: 'obligation-sarah-2',
          customerId: 'customer-sarah',
          amountMinor: nairaToMinorUnits(80),
          timestamp: '2026-08-30T09:30:00.000Z',
        }),
      ]);

      const before = await runtime.service.getLedger('demo');
      const response = await runtime.service.processMessage({
        text: 'Sarah paid $50',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      expect(response.status).toBe('clarification_required');
      expect(await runtime.service.getLedger('demo')).toEqual(before);
    } finally {
      await runtime.cleanup();
    }
  });

  it('mirrors successful web updates to the linked Telegram chat once', async () => {
    const notifier = new RecordingTelegramNotifier();
    const runtime = await tempService(null, { telegramNotifier: notifier });

    try {
      const token = await runtime.service.createTelegramLinkToken('web-user');
      const linked = await runtime.service.consumeTelegramLinkToken({
        token: token.token,
        telegramUserId: '444',
        telegramUsername: 'merchant',
      });
      expect(linked).not.toBeNull();

      const response = await runtime.service.processMessage({
        text: 'Bisi owes 5k',
        sessionId: 'web-user',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
        origin: 'web',
      });

      expect(response.status).toBe('applied');
      expect(notifier.messages).toHaveLength(1);
      expect(notifier.messages[0]).toMatchObject({
        chatId: 444,
        text: response.message,
      });

      const ledger = await runtime.service.getLedger('web-user');
      expect(ledger.obligations).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it('does not send a Telegram confirmation for unlinked web users', async () => {
    const notifier = new RecordingTelegramNotifier();
    const runtime = await tempService(null, { telegramNotifier: notifier });

    try {
      const response = await runtime.service.processMessage({
        text: 'Bisi owes 5k',
        sessionId: 'unlinked-user',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
        origin: 'web',
      });

      expect(response.status).toBe('applied');
      expect(notifier.messages).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it('disconnects a linked Telegram account without changing the ledger', async () => {
    const runtime = await tempService(null);

    try {
      await runtime.service.processMessage({
        text: 'Sarah owes 200 dollars',
        sessionId: 'demo',
        referenceTime: '2026-08-31T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });
      const before = await runtime.service.getLedger('demo');

      const token = await runtime.service.createTelegramLinkToken('demo');
      const linked = await runtime.service.consumeTelegramLinkToken({
        token: token.token,
        telegramUserId: '444',
        telegramUsername: 'merchant',
      });
      expect(linked).not.toBeNull();

      const cookie = `talli_session=${linked?.webSessionToken ?? ''}`;
      const connectedMe = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/me', {
          headers: {
            cookie,
          },
        }),
      );
      expect(await connectedMe.json()).toMatchObject({
        connected: true,
        userId: 'demo',
      });

      const disconnectResponse = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/auth/telegram/disconnect', {
          method: 'POST',
          headers: {
            cookie,
          },
        }),
      );
      expect(disconnectResponse.status).toBe(200);
      expect(await runtime.store.getTelegramLink('444')).toBeNull();

      const disconnectedMe = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/me', {
          headers: {
            cookie,
          },
        }),
      );
      expect(await disconnectedMe.json()).toMatchObject({
        connected: false,
        userId: 'demo',
      });

      expect(await runtime.service.getLedger('demo')).toEqual(before);

      const relinkToken = await runtime.service.createTelegramLinkToken('demo');
      const relinked = await runtime.service.consumeTelegramLinkToken({
        token: relinkToken.token,
        telegramUserId: '444',
        telegramUsername: 'merchant',
      });
      expect(relinked).not.toBeNull();
      expect(await runtime.store.getTelegramLink('444')).not.toBeNull();
    } finally {
      await runtime.cleanup();
    }
  });

  it('keeps the ledger mutation successful if Telegram sending fails', async () => {
    const notifier = new RecordingTelegramNotifier();
    notifier.failNextSend = true;
    const runtime = await tempService(null, { telegramNotifier: notifier });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => void 0);

    try {
      const token = await runtime.service.createTelegramLinkToken('web-user');
      await runtime.service.consumeTelegramLinkToken({
        token: token.token,
        telegramUserId: '444',
        telegramUsername: 'merchant',
      });

      const response = await runtime.service.processMessage({
        text: 'Bisi owes 5k',
        sessionId: 'web-user',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
        origin: 'web',
      });

      expect(response.status).toBe('applied');
      expect(notifier.messages).toHaveLength(0);
      const ledger = await runtime.service.getLedger('web-user');
      expect(ledger.obligations).toHaveLength(1);
    } finally {
      consoleErrorSpy.mockRestore();
      await runtime.cleanup();
    }
  });

  it('can mirror a clarification turn to Telegram without mutating the ledger', async () => {
    const notifier = new RecordingTelegramNotifier();
    const runtime = await tempService(null, { telegramNotifier: notifier });

    try {
      const token = await runtime.service.createTelegramLinkToken('web-user');
      await runtime.service.consumeTelegramLinkToken({
        token: token.token,
        telegramUserId: '444',
        telegramUsername: 'merchant',
      });

      await runtime.service.processMessage({
        text: 'Sarah owes 200 dollars',
        sessionId: 'web-user',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
        origin: 'web',
      });

      const before = await runtime.service.getLedger('web-user');
      const response = await runtime.service.processMessage({
        text: 'James owes 10 pounds',
        sessionId: 'web-user',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
        origin: 'web',
      });

      expect(response.status).toBe('clarification_required');
      expect(notifier.messages).toHaveLength(2);
      expect(notifier.messages.at(-1)?.text).toBe(response.message);
      const after = await runtime.service.getLedger('web-user');
      expect(after).toEqual(before);
    } finally {
      await runtime.cleanup();
    }
  });

  it('stores clarification state and clears it after a resolved follow-up turn', async () => {
    const interpreter = new ScriptedInterpreter([
      makeAction({
        type: 'REQUEST_CLARIFICATION',
        question: 'Which customer did you mean?',
        ambiguityKind: 'customer',
        candidateCustomerIds: ['customer-musa-a', 'customer-musa-b'],
        candidateObligationIds: [],
        permittedMutation: false,
        evidence: ['Musa paid 10k.'],
        clarification: {
          reason: 'Ambiguous customer',
          candidateCustomerIds: ['customer-musa-a', 'customer-musa-b'],
          candidateObligationIds: [],
        },
      }),
      makeAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'id', customerId: 'customer-musa-a' },
        obligation: { kind: 'id', obligationId: 'obligation-musa-a' },
        amountMinor: nairaToMinorUnits(10_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['The one who owes 30k.'],
        source: { utterance: 'The one who owes 30k.', language: 'en' },
      }),
    ]);
    const runtime = await tempService(interpreter);

    try {
      await runtime.service.seedDemoLedger('demo');

      const first = await runtime.service.processMessage({
        text: 'Please ask about the customer.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });
      expect(first.status).toBe('clarification_required');

      const loaded = await runtime.service.loadSession('demo');
      expect(loaded.state.pendingClarification?.candidateCustomerIds).toEqual(
        expect.arrayContaining(['customer-musa-a', 'customer-musa-b']),
      );

      const second = await runtime.service.processMessage({
        text: 'Use the first option.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });
      expect(second.status).toBe('applied');
      expect(interpreter.lastInput?.pendingClarification?.candidateCustomerIds).toEqual(
        expect.arrayContaining(['customer-musa-a', 'customer-musa-b']),
      );

      const reloaded = await runtime.service.loadSession('demo');
      expect(reloaded.state.pendingClarification).toBeNull();
    } finally {
      await runtime.cleanup();
    }
  });

  it('fails safely when the provider is unavailable', async () => {
    const runtime = await tempService(null);

    try {
      await runtime.service.seedDemoLedger('demo');
      const before = await runtime.service.getLedger('demo');
      const response = await runtime.service.processMessage({
        text: 'Please review the ledger.',
        sessionId: 'demo',
      });

      expect(response.status).toBe('error');
      expect(response.message).toContain('Nothing was changed');
      expect(response.message).not.toMatch(/stack|fetch failed|zod/i);

      const after = await runtime.service.getLedger('demo');
      expect(after).toEqual(before);
    } finally {
      await runtime.cleanup();
    }
  });

  it('resets the demo ledger deterministically', async () => {
    const runtime = await tempService(null);

    try {
      await runtime.service.seedDemoLedger('demo');
      const first = await runtime.service.getLedger('demo');
      await runtime.service.resetDemoLedger('demo');
      await runtime.service.seedDemoLedger('demo');
      const second = await runtime.service.getLedger('demo');

      expect(first.customers.map((customer) => customer.displayName)).toEqual(
        second.customers.map((customer) => customer.displayName),
      );
      expect(first.obligations.map((obligation) => obligation.originalAmountMinor)).toEqual(
        second.obligations.map((obligation) => obligation.originalAmountMinor),
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it('returns a safe structured API error without exposing a stack trace', async () => {
    const runtime = await tempService(null);

    try {
      const response = await handleTalliApiRequest(
        runtime.service,
        new Request('http://localhost/api/message', {
          method: 'POST',
          body: JSON.stringify({ text: 'Please review the ledger.' }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        message: string;
        errorCode: string;
      };
      expect(body.status).toBe('error');
      expect(body.message).toContain('Nothing was changed');
      expect(body.errorCode).toBe('PROVIDER_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toMatch(/stack|zod/i);
    } finally {
      await runtime.cleanup();
    }
  });
});
