import { ledgerActionSchema } from '../domain/actions.js';
import type { LedgerAction } from '../domain/actions.js';
import {
  type LedgerDocument,
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';
import type { SessionState } from './storage.js';

export interface DemoSeed {
  document: LedgerDocument;
  state: Partial<SessionState>;
}

const DEMO_SEED_TIMESTAMP = '2026-08-29T09:00:00+01:00';

function applySeedAction(
  document: LedgerDocument,
  action: LedgerAction,
  turnId: string,
  timestamp: string,
) {
  return applyLedgerAction(document, ledgerActionSchema.parse(action), {
    now: new Date(timestamp),
    actor: 'system',
    turnId,
    sourceText: action.source?.utterance,
    idFactory: createIdFactory(`${turnId}-evt`),
  }).document;
}

export function buildDemoSeed(): DemoSeed {
  const start = '2026-08-20T09:00:00.000Z';
  let document = createLedgerDocument('demo-ledger');

  document = applySeedAction(
    document,
    {
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: 'Mama Tobi', aliases: ['Tobi'] },
      amountMinor: nairaToMinorUnits(50_000),
      dueAt: '2026-08-31T00:00:00.000Z',
      permittedMutation: true,
      evidence: ['Mama Tobi carry goods of 50k yesterday.'],
      source: { utterance: 'Mama Tobi carry goods of 50k yesterday.', language: 'pcm' },
    },
    'seed-1',
    start,
  );

  document = applySeedAction(
    document,
    {
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
    },
    'seed-2',
    '2026-08-21T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: 'Musa', aliases: [] },
      amountMinor: nairaToMinorUnits(30_000),
      permittedMutation: true,
      evidence: ['Musa took 30k goods.'],
      source: { utterance: 'Musa took 30k goods.', language: 'en' },
    },
    'seed-3',
    '2026-08-22T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: 'Musa', aliases: [] },
      amountMinor: nairaToMinorUnits(40_000),
      permittedMutation: true,
      evidence: ['Musa took 40k goods.'],
      source: { utterance: 'Musa took 40k goods.', language: 'en' },
    },
    'seed-4',
    '2026-08-23T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: 'Bola', aliases: [] },
      amountMinor: nairaToMinorUnits(18_000),
      permittedMutation: true,
      evidence: ['Bola took 18k goods last week.'],
      source: { utterance: 'Bola took 18k goods last week.', language: 'en' },
    },
    'seed-5',
    '2026-08-24T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'RECORD_PAYMENT',
      customer: { kind: 'name', name: 'Bola', allowCreate: false },
      obligation: {
        kind: 'latestOpenForCustomer',
        customer: { kind: 'name', name: 'Bola', allowCreate: false },
      },
      amountMinor: nairaToMinorUnits(18_000),
      settleRemaining: false,
      permittedMutation: true,
      evidence: ['Bola paid everything.'],
      source: { utterance: 'Bola paid everything.', language: 'en' },
    },
    'seed-6',
    '2026-08-25T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'CREATE_OBLIGATION',
      customer: { kind: 'new', name: 'Kemi', aliases: [] },
      amountMinor: nairaToMinorUnits(24_000),
      permittedMutation: true,
      evidence: ['Kemi took 24k goods.'],
      source: { utterance: 'Kemi took 24k goods.', language: 'en' },
    },
    'seed-7',
    '2026-08-26T09:00:00.000Z',
  );

  document = applySeedAction(
    document,
    {
      type: 'CORRECT_OBLIGATION',
      obligation: {
        kind: 'latestOpenForCustomer',
        customer: { kind: 'name', name: 'Kemi', allowCreate: false },
      },
      correctedAmountMinor: nairaToMinorUnits(42_000),
      correctionReason: 'Customer clarified the original amount.',
      permittedMutation: true,
      evidence: ['No, it was 42k.'],
      source: { utterance: 'No, it was 42k.', language: 'pcm' },
    },
    'seed-8',
    '2026-08-27T09:00:00.000Z',
  );

  const snapshot = projectLedger(document);
  void snapshot;
  return {
    document,
    state: {
      ledgerId: document.id,
      recentTurns: [],
      pendingClarification: null,
      demoSeededAt: DEMO_SEED_TIMESTAMP,
      timezone: 'Africa/Lagos',
      updatedAt: DEMO_SEED_TIMESTAMP,
      createdAt: DEMO_SEED_TIMESTAMP,
      version: 1,
      sessionId: 'default',
    } as Partial<SessionState>,
  };
}

export function buildDemoLedgerSummary(): string {
  const seed = buildDemoSeed();
  const snapshot = projectLedger(seed.document);
  return `customers=${snapshot.customers.length}, obligations=${snapshot.obligations.length}`;
}
