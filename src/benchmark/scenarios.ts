import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerEvent,
  type LedgerSnapshot,
  type ResolveContext,
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';

export const BENCHMARK_REFERENCE_NOW = '2026-08-29T09:00:00+01:00';
export const BENCHMARK_TIMEZONE = 'Africa/Lagos';

export const BENCHMARK_CLOCK = {
  referenceNow: BENCHMARK_REFERENCE_NOW,
  timezone: BENCHMARK_TIMEZONE,
} as const;

export interface BenchmarkTurn {
  id: string;
  inputText: string;
  language: 'en' | 'pcm' | 'mixed';
  expectedAction: LedgerAction;
  expectMutation: boolean;
  expectedSnapshot: LedgerSnapshot;
  evaluatorNotes: string;
}

export interface BenchmarkScenario {
  id: string;
  status: 'locked';
  title: string;
  purpose: string;
  clock: typeof BENCHMARK_CLOCK;
  startingDocument: LedgerDocument;
  startingSnapshot: LedgerSnapshot;
  turns: BenchmarkTurn[];
}

function eventId(scenarioId: string, label: string): string {
  return `${scenarioId}:${label}`;
}

function seedDocument(documentId: string, events: LedgerEvent[]): LedgerDocument {
  const document = createLedgerDocument(documentId);
  document.events = [...events];
  return document;
}

export function createBenchmarkContext(
  scenarioId: string,
  turnId: string,
  sourceText: string,
): ResolveContext {
  return {
    now: new Date(BENCHMARK_REFERENCE_NOW),
    turnId,
    sourceText,
    actor: 'system',
    idFactory: createIdFactory(`bench-${scenarioId}-${turnId}`),
  };
}

function applyExpectedTurn(
  document: LedgerDocument,
  action: LedgerAction,
  scenarioId: string,
  turnId: string,
  sourceText: string,
): { document: LedgerDocument; snapshot: LedgerSnapshot } {
  const result = applyLedgerAction(
    document,
    action,
    createBenchmarkContext(scenarioId, turnId, sourceText),
  );
  return {
    document: result.document,
    snapshot: result.snapshot,
  };
}

function makeTurn(input: {
  scenarioId: string;
  turnId: string;
  inputText: string;
  language: 'en' | 'pcm' | 'mixed';
  action: LedgerAction;
  expectedSnapshot: LedgerSnapshot;
  evaluatorNotes: string;
}): BenchmarkTurn {
  void input.scenarioId;
  return {
    id: input.turnId,
    inputText: input.inputText,
    language: input.language,
    expectedAction: ledgerActionSchema.parse(input.action),
    expectMutation:
      input.action.type !== 'REQUEST_CLARIFICATION' && input.action.type !== 'NO_ACTION',
    expectedSnapshot: input.expectedSnapshot,
    evaluatorNotes: input.evaluatorNotes,
  };
}

function emptyScenario(id: string, title: string, purpose: string): BenchmarkScenario {
  const startingDocument = createLedgerDocument(`scenario-${id}-starting`);
  return {
    id,
    status: 'locked',
    title,
    purpose,
    clock: BENCHMARK_CLOCK,
    startingDocument,
    startingSnapshot: projectLedger(startingDocument),
    turns: [],
  };
}

function withTurns(
  scenario: BenchmarkScenario,
  turns: BenchmarkTurn[],
  startingDocument = scenario.startingDocument,
): BenchmarkScenario {
  return {
    ...scenario,
    turns,
    startingDocument,
    startingSnapshot: projectLedger(startingDocument),
  };
}

const scenario1 = (() => {
  const base = emptyScenario(
    'simple-new-credit',
    'Simple New Credit',
    'Basic extraction and obligation creation with a deterministic due date.',
  );

  const turn1Text = "Amina took 35 thousand naira worth of goods today. She'll pay on Friday.";
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Amina', aliases: [] },
    amountMinor: nairaToMinorUnits(35_000),
    dueAt: '2026-09-03T23:00:00.000Z',
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };

  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'en',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes:
        'Creates the first customer and a single open obligation. The Friday date is resolved against the fixed benchmark clock.',
    }),
  ]);
})();

const scenario2 = (() => {
  const base = emptyScenario(
    'partial-payment',
    'Partial Payment',
    'A debt is created and a later turn records a partial repayment against the same obligation.',
  );

  const turn1Text = 'Amina took 50 thousand naira worth of goods.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Amina', aliases: [] },
    amountMinor: nairaToMinorUnits(50_000),
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );
  const customerId = turn1Result.snapshot.customers[0]?.id ?? '';
  const obligationId = turn1Result.snapshot.obligations[0]?.id ?? '';

  const turn2Text = 'Amina brought 10k this morning.';
  const turn2Action: LedgerAction = {
    type: 'RECORD_PAYMENT',
    customer: { kind: 'id', customerId },
    obligation: { kind: 'id', obligationId },
    amountMinor: nairaToMinorUnits(10_000),
    settleRemaining: false,
    permittedMutation: true,
    evidence: [turn2Text, turn1Text],
    source: { utterance: turn2Text, language: 'en' },
  };
  const turn2Result = applyExpectedTurn(
    turn1Result.document,
    turn2Action,
    base.id,
    'turn-2',
    turn2Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'en',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes: 'Creates the debt that the partial payment will target.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-2',
      inputText: turn2Text,
      language: 'en',
      action: turn2Action,
      expectedSnapshot: turn2Result.snapshot,
      evaluatorNotes:
        'Records a partial payment on the existing obligation; the debt stays open with a reduced balance.',
    }),
  ]);
})();

const scenario3 = (() => {
  const base = emptyScenario(
    'full-settlement',
    'Full Settlement',
    'A debt is created, partially repaid, and then fully settled without creating duplicate records.',
  );

  const turn1Text = 'Amina took 60k goods yesterday.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Amina', aliases: [] },
    amountMinor: nairaToMinorUnits(60_000),
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );
  const customerId = turn1Result.snapshot.customers[0]?.id ?? '';
  const obligationId = turn1Result.snapshot.obligations[0]?.id ?? '';

  const turn2Text = 'Amina brought 20k this afternoon.';
  const turn2Action: LedgerAction = {
    type: 'RECORD_PAYMENT',
    customer: { kind: 'id', customerId },
    obligation: { kind: 'id', obligationId },
    amountMinor: nairaToMinorUnits(20_000),
    settleRemaining: false,
    permittedMutation: true,
    evidence: [turn2Text, turn1Text],
    source: { utterance: turn2Text, language: 'en' },
  };
  const turn2Result = applyExpectedTurn(
    turn1Result.document,
    turn2Action,
    base.id,
    'turn-2',
    turn2Text,
  );

  const turn3Text = 'She has brought the remaining money.';
  const turn3Action: LedgerAction = {
    type: 'SETTLE_OBLIGATION',
    obligation: {
      kind: 'reference',
      phrase: 'the remaining money',
      previousTurnId: 'turn-1',
    },
    permittedMutation: true,
    evidence: [turn3Text, turn2Text],
    source: { utterance: turn3Text, language: 'en' },
  };
  const turn3Result = applyExpectedTurn(
    turn2Result.document,
    turn3Action,
    base.id,
    'turn-3',
    turn3Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'en',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes: 'Creates the initial balance to be paid in stages.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-2',
      inputText: turn2Text,
      language: 'en',
      action: turn2Action,
      expectedSnapshot: turn2Result.snapshot,
      evaluatorNotes: 'Records a partial repayment and leaves the obligation open.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-3',
      inputText: turn3Text,
      language: 'en',
      action: turn3Action,
      expectedSnapshot: turn3Result.snapshot,
      evaluatorNotes:
        'Settles the remaining balance from the same obligation without creating a duplicate payment record.',
    }),
  ]);
})();

const scenario4 = (() => {
  const base = emptyScenario(
    'correction',
    'Correction',
    'A previously recorded debt is amended after partial payment and the correction preserves the payment history.',
  );

  const turn1Text = 'Kemi took 24 thousand worth of goods.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Kemi', aliases: [] },
    amountMinor: nairaToMinorUnits(24_000),
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );
  const customerId = turn1Result.snapshot.customers[0]?.id ?? '';
  const obligationId = turn1Result.snapshot.obligations[0]?.id ?? '';

  const turn2Text = 'Kemi brought 4k this morning.';
  const turn2Action: LedgerAction = {
    type: 'RECORD_PAYMENT',
    customer: { kind: 'id', customerId },
    obligation: { kind: 'id', obligationId },
    amountMinor: nairaToMinorUnits(4_000),
    settleRemaining: false,
    permittedMutation: true,
    evidence: [turn2Text, turn1Text],
    source: { utterance: turn2Text, language: 'en' },
  };
  const turn2Result = applyExpectedTurn(
    turn1Result.document,
    turn2Action,
    base.id,
    'turn-2',
    turn2Text,
  );

  const turn3Text = 'That Kemi money I told you earlier, it wasn’t 24. It was 42 thousand.';
  const turn3Action: LedgerAction = {
    type: 'CORRECT_OBLIGATION',
    obligation: {
      kind: 'reference',
      phrase: 'That Kemi money I told you earlier',
      previousTurnId: 'turn-1',
    },
    correctedAmountMinor: nairaToMinorUnits(42_000),
    correctionReason: 'Customer clarified the original sale amount.',
    permittedMutation: true,
    evidence: [turn3Text, turn2Text],
    source: { utterance: turn3Text, language: 'en' },
  };
  const turn3Result = applyExpectedTurn(
    turn2Result.document,
    turn3Action,
    base.id,
    'turn-3',
    turn3Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'en',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes: 'Creates the original debt that will later be amended.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-2',
      inputText: turn2Text,
      language: 'en',
      action: turn2Action,
      expectedSnapshot: turn2Result.snapshot,
      evaluatorNotes: 'Records a real partial payment before the correction arrives.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-3',
      inputText: turn3Text,
      language: 'en',
      action: turn3Action,
      expectedSnapshot: turn3Result.snapshot,
      evaluatorNotes:
        'Amends the original obligation in place. The earlier payment remains attached, and outstanding balance is recomputed to 38k.',
    }),
  ]);
})();

const scenario5 = (() => {
  const settledCustomerId = 'customer-hauwa';
  const settledObligationId = 'obligation-hauwa-old';
  const startingDocument = seedDocument('scenario-repeat-customer-start', [
    {
      id: eventId('repeat-customer-new-obligation', 'customer-created'),
      kind: 'customer.created',
      timestamp: '2026-08-10T09:00:00.000Z',
      actor: 'system',
      customerId: settledCustomerId,
      displayName: 'Hauwa',
      aliases: [],
    },
    {
      id: eventId('repeat-customer-new-obligation', 'obligation-created'),
      kind: 'obligation.created',
      timestamp: '2026-08-11T09:00:00.000Z',
      actor: 'system',
      customerId: settledCustomerId,
      obligationId: settledObligationId,
      originalAmountMinor: nairaToMinorUnits(8_000),
      dueAt: null,
    },
    {
      id: eventId('repeat-customer-new-obligation', 'payment-recorded'),
      kind: 'payment.recorded',
      timestamp: '2026-08-12T09:00:00.000Z',
      actor: 'system',
      customerId: settledCustomerId,
      obligationId: settledObligationId,
      amountMinor: nairaToMinorUnits(8_000),
      outstandingBeforeMinor: nairaToMinorUnits(8_000),
      outstandingAfterMinor: 0,
    },
  ]);
  const base: BenchmarkScenario = {
    id: 'repeat-customer-new-obligation',
    status: 'locked',
    title: 'Repeat Customer, New Obligation',
    purpose:
      'An existing customer with historical history takes a separate credit purchase and the old obligation must remain intact.',
    clock: BENCHMARK_CLOCK,
    startingDocument,
    startingSnapshot: projectLedger(startingDocument),
    turns: [],
  };

  const turn1Text = 'Hauwa took 15k goods again.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'id', customerId: settledCustomerId },
    amountMinor: nairaToMinorUnits(15_000),
    dueAt: null,
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );

  return withTurns(
    base,
    [
      makeTurn({
        scenarioId: base.id,
        turnId: 'turn-1',
        inputText: turn1Text,
        language: 'en',
        action: turn1Action,
        expectedSnapshot: turn1Result.snapshot,
        evaluatorNotes:
          'Uses the existing customer record and creates a fresh obligation alongside the older settled one.',
      }),
    ],
    startingDocument,
  );
})();

const scenario6 = (() => {
  const base = emptyScenario(
    'natural-reference-resolution',
    'Natural Reference Resolution',
    'A later turn uses a history-dependent phrase that should resolve uniquely to the earlier obligation.',
  );

  const turn1Text = 'Bola took 18k goods last week.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Bola', aliases: [] },
    amountMinor: nairaToMinorUnits(18_000),
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );
  const bolaCustomerId = turn1Result.snapshot.customers[0]?.id ?? '';

  const turn2Text = 'Tunde took 22k goods today.';
  const turn2Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Tunde', aliases: [] },
    amountMinor: nairaToMinorUnits(22_000),
    permittedMutation: true,
    evidence: [turn2Text],
    source: { utterance: turn2Text, language: 'en' },
  };
  const turn2Result = applyExpectedTurn(
    turn1Result.document,
    turn2Action,
    base.id,
    'turn-2',
    turn2Text,
  );

  const turn3Text = 'That money from last week, Bola bring 5k this morning.';
  const turn3Action: LedgerAction = {
    type: 'RECORD_PAYMENT',
    customer: { kind: 'id', customerId: bolaCustomerId },
    obligation: {
      kind: 'reference',
      phrase: 'that money from last week',
      previousTurnId: 'turn-1',
    },
    amountMinor: nairaToMinorUnits(5_000),
    settleRemaining: false,
    permittedMutation: true,
    evidence: [turn3Text, turn2Text],
    source: { utterance: turn3Text, language: 'en' },
  };
  const turn3Result = applyExpectedTurn(
    turn2Result.document,
    turn3Action,
    base.id,
    'turn-3',
    turn3Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'en',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes: 'Introduces the historical debt that later reference language should target.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-2',
      inputText: turn2Text,
      language: 'en',
      action: turn2Action,
      expectedSnapshot: turn2Result.snapshot,
      evaluatorNotes:
        'Creates a second debt so the later reference must be resolved by the phrase, not by simple recency.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-3',
      inputText: turn3Text,
      language: 'en',
      action: turn3Action,
      expectedSnapshot: turn3Result.snapshot,
      evaluatorNotes:
        'Resolves the reference to the earlier Bola debt and records a payment against the correct obligation.',
    }),
  ]);
})();

const scenario7 = (() => {
  const startingDocument = seedDocument('scenario-ambiguous-musa-start', [
    {
      id: eventId('ambiguous-customer-abstain', 'customer-1'),
      kind: 'customer.created',
      timestamp: '2026-08-17T09:00:00.000Z',
      actor: 'system',
      customerId: 'customer-musa-a',
      displayName: 'Musa',
      aliases: [],
    },
    {
      id: eventId('ambiguous-customer-abstain', 'obligation-1'),
      kind: 'obligation.created',
      timestamp: '2026-08-17T09:10:00.000Z',
      actor: 'system',
      customerId: 'customer-musa-a',
      obligationId: 'obligation-musa-a',
      originalAmountMinor: nairaToMinorUnits(20_000),
      dueAt: null,
    },
    {
      id: eventId('ambiguous-customer-abstain', 'customer-2'),
      kind: 'customer.created',
      timestamp: '2026-08-18T09:00:00.000Z',
      actor: 'system',
      customerId: 'customer-musa-b',
      displayName: 'Musa',
      aliases: [],
    },
    {
      id: eventId('ambiguous-customer-abstain', 'obligation-2'),
      kind: 'obligation.created',
      timestamp: '2026-08-18T09:10:00.000Z',
      actor: 'system',
      customerId: 'customer-musa-b',
      obligationId: 'obligation-musa-b',
      originalAmountMinor: nairaToMinorUnits(40_000),
      dueAt: null,
    },
  ]);
  const base: BenchmarkScenario = {
    id: 'ambiguous-customer-abstain',
    status: 'locked',
    title: 'Ambiguous Customer, Must Abstain',
    purpose:
      'Two distinct customers share the same name, so the ledger must not guess which account should be mutated.',
    clock: BENCHMARK_CLOCK,
    startingDocument,
    startingSnapshot: projectLedger(startingDocument),
    turns: [],
  };

  const turn1Text = 'Musa paid 10k.';
  const turn1Action: LedgerAction = {
    type: 'REQUEST_CLARIFICATION',
    question: 'Which Musa did you mean?',
    ambiguityKind: 'customer',
    candidateCustomerIds: ['customer-musa-a', 'customer-musa-b'],
    candidateObligationIds: [],
    permittedMutation: false,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'en' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );

  return withTurns(
    base,
    [
      makeTurn({
        scenarioId: base.id,
        turnId: 'turn-1',
        inputText: turn1Text,
        language: 'en',
        action: turn1Action,
        expectedSnapshot: turn1Result.snapshot,
        evaluatorNotes:
          'This is the key safety case: the correct response is clarification and the financial state must remain unchanged.',
      }),
    ],
    startingDocument,
  );
})();

const scenario8 = (() => {
  const base = emptyScenario(
    'pidgin-multi-turn',
    'Hard Nigerian Pidgin Multi-Turn',
    'A harder Pidgin scenario combines creation, partial repayment, correction, reference resolution, and settlement.',
  );

  const turn1Text =
    'Mama Tobi carry goods of 50k yesterday. She talk say she go pay before Monday.';
  const turn1Action: LedgerAction = {
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
    amountMinor: nairaToMinorUnits(50_000),
    dueAt: '2026-08-30T23:00:00.000Z',
    permittedMutation: true,
    evidence: [turn1Text],
    source: { utterance: turn1Text, language: 'pcm' },
  };
  const turn1Result = applyExpectedTurn(
    base.startingDocument,
    turn1Action,
    base.id,
    'turn-1',
    turn1Text,
  );
  const mamaTobiCustomerId = turn1Result.snapshot.customers[0]?.id ?? '';

  const turn2Text = 'Mama Tobi don bring 20k from that money.';
  const turn2Action: LedgerAction = {
    type: 'RECORD_PAYMENT',
    customer: { kind: 'id', customerId: mamaTobiCustomerId },
    obligation: {
      kind: 'reference',
      phrase: 'that money',
      previousTurnId: 'turn-1',
    },
    amountMinor: nairaToMinorUnits(20_000),
    settleRemaining: false,
    permittedMutation: true,
    evidence: [turn2Text, turn1Text],
    source: { utterance: turn2Text, language: 'pcm' },
  };
  const turn2Result = applyExpectedTurn(
    turn1Result.document,
    turn2Action,
    base.id,
    'turn-2',
    turn2Text,
  );

  const turn3Text = 'No be 50k I talk for the first one, na 45k.';
  const turn3Action: LedgerAction = {
    type: 'CORRECT_OBLIGATION',
    obligation: {
      kind: 'reference',
      phrase: 'the first one',
      previousTurnId: 'turn-1',
    },
    correctedAmountMinor: nairaToMinorUnits(45_000),
    correctionReason: 'User corrected the original amount.',
    permittedMutation: true,
    evidence: [turn3Text, turn2Text],
    source: { utterance: turn3Text, language: 'pcm' },
  };
  const turn3Result = applyExpectedTurn(
    turn2Result.document,
    turn3Action,
    base.id,
    'turn-3',
    turn3Text,
  );

  const turn4Text = 'The remaining one, clear am.';
  const turn4Action: LedgerAction = {
    type: 'SETTLE_OBLIGATION',
    obligation: {
      kind: 'reference',
      phrase: 'the remaining one',
      previousTurnId: 'turn-1',
    },
    permittedMutation: true,
    evidence: [turn4Text, turn3Text],
    source: { utterance: turn4Text, language: 'pcm' },
  };
  const turn4Result = applyExpectedTurn(
    turn3Result.document,
    turn4Action,
    base.id,
    'turn-4',
    turn4Text,
  );

  return withTurns(base, [
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-1',
      inputText: turn1Text,
      language: 'pcm',
      action: turn1Action,
      expectedSnapshot: turn1Result.snapshot,
      evaluatorNotes:
        'Creates the Pidgin debt and anchors a deterministic due date relative to the fixed benchmark clock.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-2',
      inputText: turn2Text,
      language: 'pcm',
      action: turn2Action,
      expectedSnapshot: turn2Result.snapshot,
      evaluatorNotes:
        'Records a partial repayment against the original debt via historical reference language.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-3',
      inputText: turn3Text,
      language: 'pcm',
      action: turn3Action,
      expectedSnapshot: turn3Result.snapshot,
      evaluatorNotes:
        'Corrects the original amount after some of the balance has already been paid.',
    }),
    makeTurn({
      scenarioId: base.id,
      turnId: 'turn-4',
      inputText: turn4Text,
      language: 'pcm',
      action: turn4Action,
      expectedSnapshot: turn4Result.snapshot,
      evaluatorNotes:
        'Uses Pidgin shorthand to settle the corrected remaining balance and close the obligation.',
    }),
  ]);
})();

export const seedScenarios: BenchmarkScenario[] = [
  scenario1,
  scenario2,
  scenario3,
  scenario4,
  scenario5,
  scenario6,
  scenario7,
  scenario8,
];
