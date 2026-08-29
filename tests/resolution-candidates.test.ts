import { describe, expect, it } from 'vitest';
import {
  type LedgerDocument,
  type LedgerEvent,
  createLedgerDocument,
  projectLedger,
} from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';
import { compileLedgerIntent } from '../src/llm/intent-compiler.js';
import { ledgerIntentSchema } from '../src/llm/intent.js';
import { buildResolutionCandidates } from '../src/llm/resolution-candidates.js';

const clock = {
  referenceNow: '2026-08-29T09:00:00+01:00',
  timezone: 'Africa/Lagos',
} as const;

function customerCreated(input: {
  customerId: string;
  displayName: string;
  timestamp: string;
  aliases?: string[];
}): LedgerEvent {
  return {
    id: `${input.customerId}:created`,
    kind: 'customer.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
  } as LedgerEvent;
}

function obligationCreated(input: {
  obligationId: string;
  customerId: string;
  amountMinor: number;
  timestamp: string;
  dueAt?: string | null;
}): LedgerEvent {
  return {
    id: `${input.obligationId}:created`,
    kind: 'obligation.created',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    obligationId: input.obligationId,
    originalAmountMinor: input.amountMinor,
    dueAt: input.dueAt ?? null,
  } as LedgerEvent;
}

function paymentRecorded(input: {
  paymentId: string;
  customerId: string;
  obligationId: string;
  amountMinor: number;
  timestamp: string;
  before: number;
  after: number;
}): LedgerEvent {
  return {
    id: input.paymentId,
    kind: 'payment.recorded',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    obligationId: input.obligationId,
    amountMinor: input.amountMinor,
    outstandingBeforeMinor: input.before,
    outstandingAfterMinor: input.after,
  } as LedgerEvent;
}

function correctionRecorded(input: {
  eventId: string;
  customerId: string;
  obligationId: string;
  previousAmountMinor: number;
  correctedAmountMinor: number;
  timestamp: string;
}): LedgerEvent {
  return {
    id: input.eventId,
    kind: 'obligation.corrected',
    timestamp: input.timestamp,
    actor: 'system',
    customerId: input.customerId,
    obligationId: input.obligationId,
    previousAmountMinor: input.previousAmountMinor,
    correctedAmountMinor: input.correctedAmountMinor,
  } as LedgerEvent;
}

function createDocument(events: LedgerEvent[]): LedgerDocument {
  const document = createLedgerDocument('resolution-tests');
  document.events = [...events];
  return document;
}

function makeContext(input: {
  snapshot: ReturnType<typeof projectLedger>;
  document: LedgerDocument;
  utterance: string;
  language?: 'en' | 'pcm' | 'mixed';
  recentTurns?: Array<{ turnId: string; text: string }>;
}) {
  const resolutionCandidates = buildResolutionCandidates({
    snapshot: input.snapshot,
    document: input.document,
    recentTurns: input.recentTurns ?? [],
    utterance: input.utterance,
    language: input.language ?? 'en',
    clock,
  });

  return {
    resolutionCandidates,
    snapshot: input.snapshot,
    document: input.document,
    utterance: input.utterance,
    language: input.language ?? 'en',
  };
}

function compileWithContext(input: {
  intent: unknown;
  snapshot: ReturnType<typeof projectLedger>;
  document: LedgerDocument;
  utterance: string;
  language?: 'en' | 'pcm' | 'mixed';
  recentTurns?: Array<{ turnId: string; text: string }>;
}) {
  const context = makeContext(input);
  return compileLedgerIntent({
    intent: ledgerIntentSchema.parse(input.intent),
    utterance: context.utterance,
    language: context.language,
    clock,
    snapshot: context.snapshot,
    document: context.document,
    resolutionCandidates: context.resolutionCandidates,
  });
}

describe('deterministic candidate retrieval', () => {
  it('returns a unique customer candidate when the utterance names them directly', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-mama-tobi',
        displayName: 'Mama Tobi',
        aliases: ['Tobi'],
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-mama-tobi',
        customerId: 'customer-mama-tobi',
        amountMinor: nairaToMinorUnits(50_000),
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'Mama Tobi paid 20k.',
      language: 'en',
      clock,
    });

    expect(package_.customerCandidates[0]).toMatchObject({
      customerId: 'customer-mama-tobi',
      displayName: 'Mama Tobi',
    });
    expect(package_.customerCandidates[0]?.reasonCodes).toEqual(
      expect.arrayContaining(['utterance_contains_name']),
    );
  });

  it('keeps duplicate-name customers as separate candidates', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-musa-a',
        displayName: 'Musa',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      customerCreated({
        customerId: 'customer-musa-b',
        displayName: 'Musa',
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'Musa paid 10k.',
      language: 'en',
      clock,
    });

    expect(package_.customerCandidates.map((candidate) => candidate.customerId)).toEqual(
      expect.arrayContaining(['customer-musa-a', 'customer-musa-b']),
    );
    expect(package_.customerCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a unique open obligation when there is only one plausible target', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-aminu',
        displayName: 'Aminu',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-aminu',
        customerId: 'customer-aminu',
        amountMinor: nairaToMinorUnits(40_000),
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [{ turnId: 'turn-1', text: 'Aminu took goods yesterday.' }],
      utterance: 'She paid 20k.',
      language: 'en',
      clock,
    });

    expect(package_.obligationCandidates[0]).toMatchObject({
      obligationId: 'obligation-aminu',
      status: 'open',
    });
    expect(package_.obligationCandidates[0]?.reasonCodes).toEqual(
      expect.arrayContaining(['open_obligation']),
    );
  });

  it('preserves multiple obligations for the same customer', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-aminu',
        displayName: 'Aminu',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-aminu-1',
        customerId: 'customer-aminu',
        amountMinor: nairaToMinorUnits(30_000),
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-aminu-2',
        customerId: 'customer-aminu',
        amountMinor: nairaToMinorUnits(20_000),
        timestamp: '2026-08-22T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'Aminu paid 10k.',
      language: 'en',
      clock,
    });

    expect(package_.obligationCandidates.map((candidate) => candidate.obligationId)).toEqual(
      expect.arrayContaining(['obligation-aminu-1', 'obligation-aminu-2']),
    );
    expect(package_.obligationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customerObligationOrdinal: 1 }),
        expect.objectContaining({ customerObligationOrdinal: 2 }),
      ]),
    );
  });

  it('exposes remaining-balance cues for open debts', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-bola',
        displayName: 'Bola',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-bola',
        customerId: 'customer-bola',
        amountMinor: nairaToMinorUnits(18_000),
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'Bola don pay the remaining money.',
      language: 'pcm',
      clock,
    });

    expect(package_.obligationCandidates[0]?.reasonCodes).toEqual(
      expect.arrayContaining(['reference_language_open_debt']),
    );
  });

  it('retains ordering metadata for first-one references', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-kemi',
        displayName: 'Kemi',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-kemi-1',
        customerId: 'customer-kemi',
        amountMinor: nairaToMinorUnits(24_000),
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-kemi-2',
        customerId: 'customer-kemi',
        amountMinor: nairaToMinorUnits(42_000),
        timestamp: '2026-08-23T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'the first one',
      language: 'en',
      clock,
    });

    expect(package_.obligationCandidates[0]).toMatchObject({
      obligationId: 'obligation-kemi-1',
      customerObligationOrdinal: 1,
    });
  });

  it('surfaces date-linked candidates for last-week references', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-bola',
        displayName: 'Bola',
        timestamp: '2026-08-19T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-bola-old',
        customerId: 'customer-bola',
        amountMinor: nairaToMinorUnits(18_000),
        timestamp: '2026-08-22T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-bola-new',
        customerId: 'customer-bola',
        amountMinor: nairaToMinorUnits(22_000),
        timestamp: '2026-08-28T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [],
      utterance: 'the one from last week',
      language: 'en',
      clock,
    });

    expect(package_.obligationCandidates[0]).toEqual(
      expect.objectContaining({
        obligationId: 'obligation-bola-old',
        createdAt: '2026-08-22T09:00:00.000Z',
        reasonCodes: expect.arrayContaining(['reference_language_open_debt']),
      }),
    );
  });

  it('uses recent turns to support a unique pronoun reference', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-hauwa',
        displayName: 'Hauwa',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-hauwa',
        customerId: 'customer-hauwa',
        amountMinor: nairaToMinorUnits(50_000),
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [{ turnId: 'turn-1', text: 'Hauwa took goods yesterday.' }],
      utterance: 'She paid 20k.',
      language: 'en',
      clock,
    });

    expect(package_.customerCandidates[0]?.displayName).toBe('Hauwa');
  });

  it('does not collapse pronoun ambiguity when multiple recent people are plausible', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-ama',
        displayName: 'Ama',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      customerCreated({
        customerId: 'customer-ada',
        displayName: 'Ada',
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [
        { turnId: 'turn-1', text: 'Ama took goods yesterday.' },
        { turnId: 'turn-2', text: 'Ada took goods yesterday.' },
      ],
      utterance: 'She paid 20k.',
      language: 'en',
      clock,
    });

    expect(package_.customerCandidates.map((candidate) => candidate.customerId)).toEqual(
      expect.arrayContaining(['customer-ama', 'customer-ada']),
    );
    expect(package_.customerCandidates.length).toBeGreaterThanOrEqual(2);
  });

  it('supports Pidgin-style references without benchmark-specific rules', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-mama-tobi',
        displayName: 'Mama Tobi',
        aliases: ['Tobi'],
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-mama-tobi',
        customerId: 'customer-mama-tobi',
        amountMinor: nairaToMinorUnits(50_000),
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);
    const package_ = buildResolutionCandidates({
      snapshot,
      document,
      recentTurns: [{ turnId: 'turn-1', text: 'Mama Tobi carry goods yesterday.' }],
      utterance: 'Mama Tobi don bring 20k from that 50k wey she owe me.',
      language: 'pcm',
      clock,
    });

    expect(package_.customerCandidates[0]?.displayName).toBe('Mama Tobi');
    expect(package_.obligationCandidates[0]).toMatchObject({
      obligationId: 'obligation-mama-tobi',
      outstandingMinor: nairaToMinorUnits(50_000),
    });
  });

  it('refuses to mutate when a duplicate customer remains ambiguous', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-musa-a',
        displayName: 'Musa',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      customerCreated({
        customerId: 'customer-musa-b',
        displayName: 'Musa',
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-musa-a',
        customerId: 'customer-musa-a',
        amountMinor: nairaToMinorUnits(20_000),
        timestamp: '2026-08-22T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-musa-b',
        customerId: 'customer-musa-b',
        amountMinor: nairaToMinorUnits(40_000),
        timestamp: '2026-08-23T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);

    const result = compileWithContext({
      intent: {
        intent: 'record_payment',
        customer: { name: 'Musa' },
        amountMinor: nairaToMinorUnits(10_000),
      },
      snapshot,
      document,
      utterance: 'Musa paid 10k.',
      language: 'en',
      recentTurns: [{ turnId: 'turn-1', text: 'Musa took goods yesterday.' }],
    });

    expect(result.action.type).toBe('REQUEST_CLARIFICATION');
    if (result.action.type !== 'REQUEST_CLARIFICATION') {
      throw new Error('Expected clarification.');
    }
    expect(result.action.candidateCustomerIds).toEqual(
      expect.arrayContaining(['customer-musa-a', 'customer-musa-b']),
    );
    expect(result.action.candidateObligationIds).toEqual([]);
  });

  it('rejects invented customer ids and obligation ids', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-aminu',
        displayName: 'Aminu',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-aminu',
        customerId: 'customer-aminu',
        amountMinor: nairaToMinorUnits(24_000),
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);

    const customerResult = compileWithContext({
      intent: {
        intent: 'record_payment',
        customer: { id: 'invented-customer' },
        amountMinor: nairaToMinorUnits(10_000),
      },
      snapshot,
      document,
      utterance: 'invented customer paid 10k.',
      language: 'en',
    });

    expect(customerResult.action.type).toBe('REQUEST_CLARIFICATION');

    const obligationResult = compileWithContext({
      intent: {
        intent: 'correct_obligation',
        obligation: { id: 'invented-obligation' },
        correctedAmountMinor: nairaToMinorUnits(42_000),
      },
      snapshot,
      document,
      utterance: 'Correct that to 42k.',
      language: 'en',
    });

    expect(obligationResult.action.type).toBe('REQUEST_CLARIFICATION');
  });

  it('filters invented clarification ids down to supplied candidates', () => {
    const document = createDocument([
      customerCreated({
        customerId: 'customer-aminu',
        displayName: 'Aminu',
        timestamp: '2026-08-20T09:00:00.000Z',
      }),
      obligationCreated({
        obligationId: 'obligation-aminu',
        customerId: 'customer-aminu',
        amountMinor: nairaToMinorUnits(24_000),
        timestamp: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    const snapshot = projectLedger(document);

    const result = compileWithContext({
      intent: {
        intent: 'request_clarification',
        clarification: {
          reason: 'Which one?',
          candidateCustomerIds: ['invented-customer'],
          candidateObligationIds: ['invented-obligation'],
        },
      },
      snapshot,
      document,
      utterance: 'Which one?',
      language: 'en',
    });

    expect(result.action.type).toBe('REQUEST_CLARIFICATION');
    if (result.action.type !== 'REQUEST_CLARIFICATION') {
      throw new Error('Expected clarification.');
    }
    expect(result.action.candidateCustomerIds).toEqual([]);
    expect(result.action.candidateObligationIds).toEqual([]);
  });
});
