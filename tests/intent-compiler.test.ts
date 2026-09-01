import { describe, expect, it } from 'vitest';
import { ledgerActionSchema } from '../src/domain/actions.js';
import {
  type LedgerSnapshot,
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';
import { compileLedgerIntent } from '../src/llm/intent-compiler.js';
import { ledgerIntentSchema } from '../src/llm/intent.js';

const clock = {
  referenceNow: '2026-08-29T09:00:00+01:00',
  timezone: 'Africa/Lagos',
} as const;

function seedObligation(input: {
  name: string;
  amountMinor: number;
  turnId?: string;
  utterance?: string;
}) {
  const document = createLedgerDocument('intent-compiler');
  const sourceText = input.utterance ?? `${input.name} took ${input.amountMinor / 100000}k goods.`;
  const result = applyLedgerAction(
    document,
    ledgerActionSchema.parse({
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: input.name, aliases: [] },
      amountMinor: input.amountMinor,
      permittedMutation: true,
      evidence: [sourceText],
      source: { utterance: sourceText, language: 'en' },
    }),
    {
      now: new Date('2026-08-28T08:00:00.000Z'),
      actor: 'system',
      turnId: input.turnId ?? 'seed-turn',
      sourceText,
      idFactory: createIdFactory('intent-compiler'),
    },
  );

  const snapshot = projectLedger(result.document);
  const customerId = snapshot.customers[0]?.id ?? '';
  const obligationId = snapshot.obligations[0]?.id ?? '';

  return {
    document: result.document,
    snapshot,
    customerId,
    obligationId,
  };
}

function createAmbiguousSnapshot(): LedgerSnapshot {
  const snapshot = projectLedger(createLedgerDocument('ambiguous-customers'));
  const createdAt = '2026-08-28T08:00:00.000Z';

  return {
    ...snapshot,
    customers: [
      {
        id: 'customer-a',
        displayName: 'Musa',
        aliases: [],
        normalizedNames: ['musa'],
        createdAt,
        updatedAt: createdAt,
        sourceEventIds: ['event-a'],
      },
      {
        id: 'customer-b',
        displayName: 'Musa',
        aliases: [],
        normalizedNames: ['musa'],
        createdAt,
        updatedAt: createdAt,
        sourceEventIds: ['event-b'],
      },
    ],
  } as LedgerSnapshot;
}

function compile(input: {
  intent: unknown;
  utterance: string;
  language?: 'en' | 'pcm' | 'mixed';
  snapshot?: LedgerSnapshot;
  document?: ReturnType<typeof createLedgerDocument>;
}) {
  const stateDocument = input.document ?? createLedgerDocument('intent-compiler');
  const stateSnapshot = input.snapshot ?? projectLedger(stateDocument);
  return compileLedgerIntent({
    intent: ledgerIntentSchema.parse(input.intent),
    utterance: input.utterance,
    language: input.language ?? 'en',
    clock,
    snapshot: stateSnapshot,
    document: stateDocument,
  });
}

describe('compact ledger intent contract', () => {
  it('rejects malformed schema payloads and invalid money amounts', () => {
    expect(ledgerIntentSchema.safeParse({ intent: 'create_obligation' }).success).toBe(true);
    expect(
      ledgerIntentSchema.safeParse({
        intent: 'create_obligation',
        amountMinor: 12.5,
      }).success,
    ).toBe(false);
    expect(
      ledgerIntentSchema.safeParse({
        amountMinor: 3500000,
        customer: { name: 'Amina' },
      }).success,
    ).toBe(false);
  });

  it('creates a new obligation for a new customer', () => {
    const result = compile({
      intent: {
        intent: 'create_obligation',
        customer: { name: 'Amina' },
        amountMinor: nairaToMinorUnits(35_000),
        evidence: ['Amina took 35 thousand naira worth of goods today.'],
      },
      utterance: "Amina took 35 thousand naira worth of goods today. She'll pay on Friday.",
    });

    expect(result.action.type).toBe('CREATE_OBLIGATION');
    if (result.action.type !== 'CREATE_OBLIGATION') {
      throw new Error('Expected a create obligation action.');
    }
    expect(result.diagnostics.outcome).toBe('action');
    expect(result.action.customer.kind).toBe('new');
    expect(result.action.amountMinor).toBe(nairaToMinorUnits(35_000));
    expect(result.action.dueAt).toBe('2026-09-03T23:00:00.000Z');
  });

  it.each([
    'John owes me 3000 naira and will pay back on Saturday',
    'John owes me 3000 naira and will pay on Saturday',
    'John owes me 3000 naira and will repay on Saturday',
    'John owes me 3000 naira and will settle on Saturday',
    'John owes me 3000 naira due Saturday',
    'John owes me 3000 naira due on Saturday',
  ])('creates a new obligation with Saturday repayment phrasing: %s', (utterance) => {
    const result = compile({
      intent: {
        intent: 'create_obligation',
        customer: { name: 'John' },
        amountMinor: nairaToMinorUnits(3_000),
      },
      utterance,
    });

    expect(result.action.type).toBe('CREATE_OBLIGATION');
    if (result.action.type !== 'CREATE_OBLIGATION') {
      throw new Error('Expected a create obligation action.');
    }

    expect(result.action.amountMinor).toBe(nairaToMinorUnits(3_000));
    expect(result.action.dueAt).toBe('2026-09-04T23:00:00.000Z');
  });

  it('resolves an existing customer by name', () => {
    const state = seedObligation({
      name: 'Amina',
      amountMinor: nairaToMinorUnits(50_000),
    });

    const result = compile({
      intent: {
        intent: 'create_obligation',
        customer: { name: 'Amina' },
        amountMinor: nairaToMinorUnits(12_000),
      },
      utterance: 'Amina took 12k more goods today.',
      snapshot: state.snapshot,
      document: state.document,
    });

    expect(result.action.type).toBe('CREATE_OBLIGATION');
    if (result.action.type !== 'CREATE_OBLIGATION') {
      throw new Error('Expected a create obligation action.');
    }
    expect(result.diagnostics.customerResolution).toBe('resolved');
    expect(result.action.customer).toEqual({
      kind: 'id',
      customerId: state.customerId,
    });
  });

  it('records a partial payment against the unique open obligation', () => {
    const state = seedObligation({
      name: 'Amina',
      amountMinor: nairaToMinorUnits(50_000),
    });

    const result = compile({
      intent: {
        intent: 'record_payment',
        customer: { name: 'Amina' },
        amountMinor: nairaToMinorUnits(10_000),
      },
      utterance: 'Amina brought 10k this morning.',
      snapshot: state.snapshot,
      document: state.document,
    });

    expect(result.action.type).toBe('RECORD_PAYMENT');
    if (result.action.type !== 'RECORD_PAYMENT') {
      throw new Error('Expected a payment action.');
    }
    expect(result.diagnostics.obligationResolution).toBe('resolved');

    const applied = applyLedgerAction(state.document, result.action, {
      now: new Date(clock.referenceNow),
      actor: 'system',
      turnId: 'payment-turn',
      sourceText: 'Amina brought 10k this morning.',
      idFactory: createIdFactory('payment'),
    });
    expect(applied.snapshot.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(40_000));
  });

  it('settles the remaining balance on a unique obligation', () => {
    const state = seedObligation({
      name: 'Amina',
      amountMinor: nairaToMinorUnits(50_000),
    });

    const result = compile({
      intent: {
        intent: 'settle_obligation',
        customer: { id: state.customerId },
        obligation: { phrase: 'the remaining money' },
        settleRemaining: true,
      },
      utterance: 'She paid the remaining money.',
      snapshot: state.snapshot,
      document: state.document,
    });

    expect(result.action.type).toBe('SETTLE_OBLIGATION');
    if (result.action.type !== 'SETTLE_OBLIGATION') {
      throw new Error('Expected a settlement action.');
    }
    expect(result.diagnostics.obligationResolution).toBe('resolved');
  });

  it('applies corrections to the existing obligation instead of creating a new debt', () => {
    const state = seedObligation({
      name: 'Kemi',
      amountMinor: nairaToMinorUnits(24_000),
    });
    const payment = applyLedgerAction(
      state.document,
      ledgerActionSchema.parse({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Kemi', allowCreate: false },
        obligation: { kind: 'id', obligationId: state.obligationId },
        amountMinor: nairaToMinorUnits(4_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Kemi brought 4k this morning.'],
        source: { utterance: 'Kemi brought 4k this morning.', language: 'en' },
      }),
      {
        now: new Date('2026-08-28T09:00:00.000Z'),
        actor: 'system',
        turnId: 'payment-turn',
        sourceText: 'Kemi brought 4k this morning.',
        idFactory: createIdFactory('correction'),
      },
    );

    const result = compile({
      intent: {
        intent: 'correct_obligation',
        obligation: { id: state.obligationId },
        correctedAmountMinor: nairaToMinorUnits(42_000),
        correctionReason: 'The original amount was 42k, not 24k.',
      },
      utterance: "That Kemi money I told you earlier, it wasn't 24. It was 42 thousand.",
      snapshot: projectLedger(payment.document),
      document: payment.document,
    });

    expect(result.action.type).toBe('CORRECT_OBLIGATION');
    if (result.action.type !== 'CORRECT_OBLIGATION') {
      throw new Error('Expected a correction action.');
    }

    const applied = applyLedgerAction(payment.document, result.action, {
      now: new Date(clock.referenceNow),
      actor: 'system',
      turnId: 'correction-turn',
      sourceText: "That Kemi money I told you earlier, it wasn't 24. It was 42 thousand.",
      idFactory: createIdFactory('correction-apply'),
    });

    expect(applied.snapshot.obligations).toHaveLength(1);
    expect(applied.snapshot.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(38_000));
    expect(applied.snapshot.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(4_000));
  });

  it('requests clarification when multiple customer candidates exist for a mutation', () => {
    const snapshot = createAmbiguousSnapshot();
    const result = compile({
      intent: {
        intent: 'record_payment',
        customer: { name: 'Musa' },
        amountMinor: nairaToMinorUnits(10_000),
      },
      utterance: 'Musa paid 10k.',
      snapshot,
      document: createLedgerDocument('ambiguous-customers'),
    });

    expect(result.action.type).toBe('REQUEST_CLARIFICATION');
    if (result.action.type !== 'REQUEST_CLARIFICATION') {
      throw new Error('Expected clarification for ambiguous customer resolution.');
    }
    expect(result.diagnostics.customerResolution).toBe('ambiguous');
    expect(result.diagnostics.outcome).toBe('clarification');
  });

  it('preserves explicit candidate ids in clarification intents', () => {
    const result = compile({
      intent: {
        intent: 'request_clarification',
        clarification: {
          reason: 'Which Musa?',
          candidateCustomerIds: ['customer-a', 'customer-b'],
          candidateObligationIds: ['obligation-a', 'obligation-b'],
        },
      },
      utterance: 'Musa paid 10k.',
    });

    expect(result.action.type).toBe('REQUEST_CLARIFICATION');
    if (result.action.type !== 'REQUEST_CLARIFICATION') {
      throw new Error('Expected clarification to remain a clarification.');
    }
    expect(result.action.candidateCustomerIds).toEqual(['customer-a', 'customer-b']);
    expect(result.action.candidateObligationIds).toEqual(['obligation-a', 'obligation-b']);
  });

  it('treats pidgin-style creation text as a normal create-obligation intent', () => {
    const result = compile({
      intent: {
        intent: 'create_obligation',
        customer: { name: 'Mama Tobi' },
        amountMinor: nairaToMinorUnits(50_000),
      },
      utterance: 'Mama Tobi carry goods of 50k yesterday.',
      language: 'pcm',
    });

    expect(result.action.type).toBe('CREATE_OBLIGATION');
    if (result.action.type !== 'CREATE_OBLIGATION') {
      throw new Error('Expected a create obligation action.');
    }
    expect(result.action.dueAt).toBe('2026-08-27T23:00:00.000Z');
  });

  it('rejects invented ids and nonexistent obligations without mutating the ledger', () => {
    const state = seedObligation({
      name: 'Amina',
      amountMinor: nairaToMinorUnits(50_000),
    });

    const result = compile({
      intent: {
        intent: 'correct_obligation',
        obligation: { id: 'does-not-exist' },
        correctedAmountMinor: nairaToMinorUnits(42_000),
      },
      utterance: 'Correct that one to 42k.',
      snapshot: state.snapshot,
      document: state.document,
    });

    expect(result.action.type).toBe('REQUEST_CLARIFICATION');
    if (result.action.type !== 'REQUEST_CLARIFICATION') {
      throw new Error('Expected safe clarification for invented ids.');
    }

    const applied = applyLedgerAction(state.document, result.action, {
      now: new Date(clock.referenceNow),
      actor: 'system',
      turnId: 'safe-fallback',
      sourceText: 'Correct that one to 42k.',
      idFactory: createIdFactory('safe-fallback'),
    });

    expect(applied.snapshot.customers).toEqual(state.snapshot.customers);
    expect(applied.snapshot.obligations).toEqual(state.snapshot.obligations);
    expect(applied.snapshot.totals).toEqual(state.snapshot.totals);
  });
});
