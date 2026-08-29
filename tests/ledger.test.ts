import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ledgerActionSchema } from '../src/domain/actions.js';
import {
  type LedgerDocument,
  type LedgerEvent,
  applyLedgerAction,
  assertLedgerInvariants,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';

const now = new Date('2026-08-28T12:00:00.000Z');

function makeContext(idFactory = createIdFactory('test')) {
  return {
    now,
    actor: 'system' as const,
    idFactory,
  };
}

function parseAction(action: Parameters<typeof ledgerActionSchema.parse>[0]) {
  return ledgerActionSchema.parse(action);
}

function apply(document: LedgerDocument, action: ReturnType<typeof parseAction>) {
  return applyLedgerAction(document, action, {
    ...makeContext(),
    sourceText: action.source?.utterance,
  });
}

function applyWithTurnId(
  document: LedgerDocument,
  action: ReturnType<typeof parseAction>,
  turnId: string,
) {
  return applyLedgerAction(document, action, {
    ...makeContext(),
    turnId,
    sourceText: action.source?.utterance,
  });
}

function createCustomerEvent(
  id: string,
  displayName: string,
  timestamp = now.toISOString(),
): LedgerEvent {
  return {
    id: randomUUID(),
    kind: 'customer.created',
    timestamp,
    actor: 'system',
    customerId: id,
    displayName,
    aliases: [],
  };
}

function createObligationEvent(
  id: string,
  customerId: string,
  customerName: string,
  amountMinor: number,
  timestamp = now.toISOString(),
): LedgerEvent {
  return {
    id: randomUUID(),
    kind: 'obligation.created',
    timestamp,
    actor: 'system',
    customerId,
    obligationId: id,
    originalAmountMinor: amountMinor,
    dueAt: null,
  };
}

describe('ledger domain', () => {
  it('creates a new debt', () => {
    const document = createLedgerDocument('ledger-create');
    const result = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
    );

    expect(result.financialMutation).toBe(true);
    expect(result.clarification).toBeUndefined();
    expect(result.snapshot.customers).toHaveLength(1);
    expect(result.snapshot.obligations).toHaveLength(1);
    expect(result.snapshot.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(50_000));
    assertLedgerInvariants(result.snapshot);
  });

  it('records a partial payment', () => {
    let document = createLedgerDocument('ledger-partial');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
    ).document;

    const payment = apply(
      document,
      parseAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Mama Tobi', allowCreate: false },
        amountMinor: nairaToMinorUnits(20_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Mama Tobi brought 20.'],
        source: { utterance: 'Mama Tobi brought 20.', language: 'en' },
      }),
    );

    expect(payment.financialMutation).toBe(true);
    expect(payment.snapshot.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(20_000));
    expect(payment.snapshot.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(30_000));
    assertLedgerInvariants(payment.snapshot);
  });

  it('settles an obligation fully', () => {
    let document = createLedgerDocument('ledger-settle');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
    ).document;

    const created = projectLedger(document).obligations[0];
    expect(created).toBeDefined();
    if (!created) {
      throw new Error('Expected an obligation to settle.');
    }
    const settled = apply(
      document,
      parseAction({
        type: 'SETTLE_OBLIGATION',
        obligation: { kind: 'id', obligationId: created.id },
        amountMinor: created.outstandingMinor,
        permittedMutation: true,
        evidence: ['Mama Tobi paid the balance.'],
        source: { utterance: 'Mama Tobi paid the balance.', language: 'en' },
      }),
    );

    expect(settled.financialMutation).toBe(true);
    expect(settled.snapshot.obligations[0]?.status).toBe('settled');
    expect(settled.snapshot.obligations[0]?.outstandingMinor).toBe(0);
    assertLedgerInvariants(settled.snapshot);
  });

  it('applies a correction without creating a second debt', () => {
    let document = createLedgerDocument('ledger-correction');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Kemi', aliases: [] },
        amountMinor: nairaToMinorUnits(24_000),
        permittedMutation: true,
        evidence: ['Kemi took 24 thousand worth of goods.'],
        source: { utterance: 'Kemi took 24 thousand worth of goods.', language: 'en' },
      }),
    ).document;

    const created = projectLedger(document).obligations[0];
    expect(created).toBeDefined();
    if (!created) {
      throw new Error('Expected a Kemi obligation to correct.');
    }
    const corrected = apply(
      document,
      parseAction({
        type: 'CORRECT_OBLIGATION',
        obligation: { kind: 'id', obligationId: created.id },
        correctedAmountMinor: nairaToMinorUnits(42_000),
        correctionReason: 'User clarified the original amount.',
        permittedMutation: true,
        evidence: ['That Kemi money, it was 42 thousand.'],
        source: { utterance: 'That Kemi money, it was 42 thousand.', language: 'en' },
      }),
    );

    expect(corrected.financialMutation).toBe(true);
    expect(corrected.snapshot.obligations).toHaveLength(1);
    expect(corrected.snapshot.obligations[0]?.originalAmountMinor).toBe(nairaToMinorUnits(42_000));
    expect(corrected.document.events.map((event) => event.kind)).toContain('obligation.corrected');
    assertLedgerInvariants(corrected.snapshot);
  });

  it('keeps repeat obligations separate for the same customer', () => {
    let document = createLedgerDocument('ledger-repeat');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
    ).document;

    const customerId = projectLedger(document).customers[0]?.id;
    expect(customerId).toBeDefined();
    if (!customerId) {
      throw new Error('Expected a customer id for the repeated obligation case.');
    }

    const repeated = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'id', customerId },
        amountMinor: nairaToMinorUnits(15_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 15k again.'],
        source: { utterance: 'Mama Tobi took 15k again.', language: 'en' },
      }),
    );

    expect(repeated.snapshot.obligations).toHaveLength(2);
    expect(
      repeated.snapshot.obligations.every((obligation) => obligation.customerId === customerId),
    ).toBe(true);
    assertLedgerInvariants(repeated.snapshot);
  });

  it('abstains when the customer identity is ambiguous', () => {
    const document = createLedgerDocument('ledger-ambiguous');
    document.events = [
      createCustomerEvent('customer-musa-1', 'Musa'),
      createObligationEvent(
        'obligation-musa-1',
        'customer-musa-1',
        'Musa',
        nairaToMinorUnits(20_000),
      ),
      createCustomerEvent('customer-musa-2', 'Musa'),
      createObligationEvent(
        'obligation-musa-2',
        'customer-musa-2',
        'Musa',
        nairaToMinorUnits(40_000),
      ),
    ];

    const before = projectLedger(document);
    const result = apply(
      document,
      parseAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Musa', allowCreate: false },
        amountMinor: nairaToMinorUnits(10_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Musa paid 10k.'],
        source: { utterance: 'Musa paid 10k.', language: 'en' },
      }),
    );

    expect(result.financialMutation).toBe(false);
    expect(result.clarification?.ambiguityKind).toBe('customer');
    expect(projectLedger(result.document)).toEqual(before);
    expect(result.document.events.length).toBe(
      before.obligations.length + before.customers.length + 1,
    );
    assertLedgerInvariants(before);
  });

  it('abstains on overpayment instead of mutating state', () => {
    let document = createLedgerDocument('ledger-overpay');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
    ).document;

    const before = projectLedger(document);
    const result = apply(
      document,
      parseAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Mama Tobi', allowCreate: false },
        amountMinor: nairaToMinorUnits(60_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Mama Tobi gave 60k.'],
        source: { utterance: 'Mama Tobi gave 60k.', language: 'en' },
      }),
    );

    expect(result.financialMutation).toBe(false);
    expect(result.clarification?.ambiguityKind).toBe('amount');
    expect(projectLedger(result.document)).toEqual(before);
    assertLedgerInvariants(before);
  });

  it('preserves audit history while keeping balances consistent', () => {
    let document = createLedgerDocument('ledger-audit');
    document = apply(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Aunty Sade', aliases: [] },
        amountMinor: nairaToMinorUnits(30_000),
        permittedMutation: true,
        evidence: ['Aunty Sade take 30k goods yesterday.'],
        source: { utterance: 'Aunty Sade take 30k goods yesterday.', language: 'pcm' },
      }),
    ).document;

    document = apply(
      document,
      parseAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Aunty Sade', allowCreate: false },
        amountMinor: nairaToMinorUnits(10_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['She bring 10 today.'],
        source: { utterance: 'She bring 10 today.', language: 'pcm' },
      }),
    ).document;

    const corrected = apply(
      document,
      parseAction({
        type: 'CORRECT_OBLIGATION',
        obligation: {
          kind: 'latestOpenForCustomer',
          customer: { kind: 'name', name: 'Aunty Sade', allowCreate: false },
        },
        correctedAmountMinor: nairaToMinorUnits(45_000),
        correctionReason: 'Customer clarified the original amount.',
        permittedMutation: true,
        evidence: ['No, e no be 30. Na 45k.'],
        source: { utterance: 'No, e no be 30. Na 45k.', language: 'pcm' },
      }),
    );

    const obligation = corrected.snapshot.obligations[0];
    expect(obligation).toBeDefined();
    if (!obligation) {
      throw new Error('Expected the corrected obligation to exist.');
    }

    expect(obligation.originalAmountMinor).toBe(nairaToMinorUnits(45_000));
    expect(obligation.originalAmountMinor - obligation.totalPaidMinor).toBe(
      obligation.outstandingMinor,
    );
    expect(corrected.document.events.map((event) => event.kind)).toEqual([
      'customer.created',
      'obligation.created',
      'payment.recorded',
      'obligation.corrected',
    ]);
    assertLedgerInvariants(corrected.snapshot);
  });

  it('resolves a reference target by previous turn id', () => {
    let document = createLedgerDocument('ledger-reference');
    document = applyWithTurnId(
      document,
      parseAction({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Bola', aliases: [] },
        amountMinor: nairaToMinorUnits(18_000),
        permittedMutation: true,
        evidence: ['Bola took 18k goods last week.'],
        source: { utterance: 'Bola took 18k goods last week.', language: 'en' },
      }),
      'turn-1',
    ).document;

    const result = apply(
      document,
      parseAction({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Bola', allowCreate: false },
        obligation: {
          kind: 'reference',
          phrase: 'that money from last week',
          previousTurnId: 'turn-1',
        },
        amountMinor: nairaToMinorUnits(5_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['That money from last week, Bola bring 5k this morning.'],
        source: {
          utterance: 'That money from last week, Bola bring 5k this morning.',
          language: 'en',
        },
      }),
    );

    expect(result.financialMutation).toBe(true);
    expect(result.snapshot.obligations[0]?.totalPaidMinor).toBe(nairaToMinorUnits(5_000));
    expect(result.snapshot.obligations[0]?.outstandingMinor).toBe(nairaToMinorUnits(13_000));
    assertLedgerInvariants(result.snapshot);
  });
});
