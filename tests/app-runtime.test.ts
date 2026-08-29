import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTalliApiRequest } from '../src/app/api.js';
import { TalliSessionStore } from '../src/app/storage.js';
import { createTalliService } from '../src/app/talli-service.js';
import { ledgerActionSchema } from '../src/domain/actions.js';
import { formatNgn, nairaToMinorUnits } from '../src/domain/money.js';
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

async function tempService(interpreter: ActionInterpreter | null = null) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talli-runtime-'));
  const store = new TalliSessionStore({ dataDir, defaultSessionId: 'demo' });
  const service = createTalliService({ store, interpreter });
  return {
    dataDir,
    store,
    service,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
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
        text: 'Kemi took 24 thousand worth of goods.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });
      await runtime.service.processMessage({
        text: 'Kemi brought 4k.',
        sessionId: 'demo',
        referenceTime: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
        language: 'en',
      });

      const response = await runtime.service.processMessage({
        text: 'That Kemi money, it was 42 thousand.',
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
        text: 'Musa paid 10k.',
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
        text: 'The one who owes 30k.',
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
        text: 'Mama Tobi paid 10k.',
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
          body: JSON.stringify({ text: 'Mama Tobi paid 10k.' }),
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
