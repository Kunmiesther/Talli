import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  createLedgerDocument,
} from '../domain/ledger.js';

export interface BenchmarkTurn {
  id: string;
  inputText: string;
  language?: 'en' | 'pcm' | 'mixed';
  expectedAction: LedgerAction;
  expectedSnapshot: LedgerSnapshot;
  expectMutation: boolean;
  notes?: string;
}

export interface BenchmarkScenario {
  id: string;
  title: string;
  purpose: string;
  reviewStatus: 'draft-review';
  startingDocument: LedgerDocument;
  startingSnapshot: LedgerSnapshot;
  turns: BenchmarkTurn[];
}

function emptySnapshot(document: LedgerDocument): LedgerSnapshot {
  return {
    id: document.id,
    currency: document.currency,
    customers: [],
    obligations: [],
    totals: {
      openOutstandingMinor: 0,
      settledOutstandingMinor: 0,
      totalPaidMinor: 0,
    },
  };
}

function newLedgerState(): { document: LedgerDocument; snapshot: LedgerSnapshot } {
  const document = createLedgerDocument();
  return { document, snapshot: emptySnapshot(document) };
}

function createCustomer(
  document: LedgerDocument,
  snapshot: LedgerSnapshot,
  id: string,
  displayName: string,
): LedgerSnapshot {
  const next: LedgerSnapshot = {
    ...snapshot,
    customers: [
      ...snapshot.customers,
      {
        id,
        displayName,
        aliases: [],
        normalizedNames: [displayName.toLowerCase()],
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        sourceEventIds: ['seed'],
      },
    ],
  };
  void document;
  return next;
}

function createObligation(
  snapshot: LedgerSnapshot,
  customerId: string,
  customerName: string,
  obligationId: string,
  originalAmountMinor: number,
  totalPaidMinor = 0,
  status: 'open' | 'settled' = originalAmountMinor - totalPaidMinor === 0 ? 'settled' : 'open',
): LedgerSnapshot {
  const obligation = {
    id: obligationId,
    customerId,
    customerName,
    originalAmountMinor,
    totalPaidMinor,
    outstandingMinor: originalAmountMinor - totalPaidMinor,
    status,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    dueAt: null,
    sourceEventIds: ['seed'],
    paymentEventIds: [],
    correctionEventIds: [],
  } satisfies LedgerSnapshot['obligations'][number];

  return {
    ...snapshot,
    obligations: [...snapshot.obligations, obligation],
  };
}

function seedScenario(
  scenario: Omit<BenchmarkScenario, 'startingDocument' | 'startingSnapshot'>,
): BenchmarkScenario {
  const { document, snapshot } = newLedgerState();
  return {
    ...scenario,
    startingDocument: document,
    startingSnapshot: snapshot,
  };
}

const baseDocument = createLedgerDocument('seed-ledger');
const baseSnapshot = emptySnapshot(baseDocument);

const mamaTobiId = 'customer-mama-tobi';
const kemiId = 'customer-kemi';
const musaOneId = 'customer-musa-1';
const musaTwoId = 'customer-musa-2';

const scenarios: BenchmarkScenario[] = [
  seedScenario({
    id: 'simple-new-debt',
    title: 'Simple new debt',
    purpose: 'Create a new customer and open a single obligation.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Mama Tobi took 50k goods yesterday.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
          amountMinor: 5_000_000,
          permittedMutation: true,
          evidence: ['Mama Tobi took 50k goods yesterday.'],
          source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
        }),
        expectedSnapshot: {
          ...baseSnapshot,
          customers: [
            {
              id: mamaTobiId,
              displayName: 'Mama Tobi',
              aliases: [],
              normalizedNames: ['mama tobi'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-mama-tobi-1',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 5_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 5_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
        notes:
          'Draft ground truth only. Review identifiers and amount normalization before locking the benchmark.',
      },
    ],
  }),
  seedScenario({
    id: 'partial-payment',
    title: 'Partial payment',
    purpose: 'Apply a partial payment against an existing open debt.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Mama Tobi brought 20.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: mamaTobiId },
          obligation: { kind: 'id', obligationId: 'obligation-mama-tobi-1' },
          amountMinor: 2_000_000,
          settleRemaining: false,
          permittedMutation: true,
          evidence: ['Mama Tobi brought 20.'],
          source: { utterance: 'Mama Tobi brought 20.', language: 'en' },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, mamaTobiId, 'Mama Tobi'),
          obligations: [
            {
              id: 'obligation-mama-tobi-1',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 5_000_000,
              totalPaidMinor: 2_000_000,
              outstandingMinor: 3_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: ['seed'],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
        notes:
          'Review whether bare "20" should always normalize to 20,000 NGN in this product context.',
      },
    ],
  }),
  seedScenario({
    id: 'full-settlement',
    title: 'Full settlement',
    purpose: 'Settle a remaining balance completely.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Mama Tobi paid the balance.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'SETTLE_OBLIGATION',
          obligation: { kind: 'id', obligationId: 'obligation-mama-tobi-1' },
          amountMinor: 3_000_000,
          permittedMutation: true,
          evidence: ['Mama Tobi paid the balance.'],
          source: { utterance: 'Mama Tobi paid the balance.', language: 'en' },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, mamaTobiId, 'Mama Tobi'),
          obligations: [
            {
              id: 'obligation-mama-tobi-1',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 5_000_000,
              totalPaidMinor: 5_000_000,
              outstandingMinor: 0,
              status: 'settled',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: ['seed'],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
      },
    ],
  }),
  seedScenario({
    id: 'amount-correction',
    title: 'Amount correction',
    purpose: 'Correct a previously recorded debt amount without creating a duplicate debt.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'That Kemi money I told you earlier, it wasn’t 24. It was 42 thousand.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'CORRECT_OBLIGATION',
          obligation: { kind: 'id', obligationId: 'obligation-kemi-1' },
          correctedAmountMinor: 4_200_000,
          correctionReason: 'Replaced previous amount',
          permittedMutation: true,
          evidence: ['That Kemi money I told you earlier, it wasn’t 24. It was 42 thousand.'],
          source: {
            utterance: 'That Kemi money I told you earlier, it wasn’t 24. It was 42 thousand.',
            language: 'en',
          },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, kemiId, 'Kemi'),
          obligations: [
            {
              id: 'obligation-kemi-1',
              customerId: kemiId,
              customerName: 'Kemi',
              originalAmountMinor: 4_200_000,
              totalPaidMinor: 0,
              outstandingMinor: 4_200_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: ['seed'],
            },
          ],
        },
        expectMutation: true,
        notes:
          'The correction target is assumed to be the earlier Kemi debt. Review this reference before finalizing benchmark truth.',
      },
    ],
  }),
  seedScenario({
    id: 'repeat-debtor-new-obligation',
    title: 'Repeat debtor, new obligation',
    purpose: 'Create a second obligation for the same debtor without overwriting the first.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Mama Tobi took 15k again.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'CREATE_OBLIGATION',
          customer: { kind: 'id', customerId: mamaTobiId },
          amountMinor: 1_500_000,
          permittedMutation: true,
          evidence: ['Mama Tobi took 15k again.'],
          source: { utterance: 'Mama Tobi took 15k again.', language: 'en' },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, mamaTobiId, 'Mama Tobi'),
          obligations: [
            {
              id: 'obligation-mama-tobi-1',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 5_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 5_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
            {
              id: 'obligation-mama-tobi-2',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 1_500_000,
              totalPaidMinor: 0,
              outstandingMinor: 1_500_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
        notes: 'This scenario should preserve both obligations independently.',
      },
    ],
  }),
  seedScenario({
    id: 'reference-previous-debt',
    title: 'Reference to a previous debt',
    purpose: 'Resolve a natural-language reference to an earlier obligation in context.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'She paid the remaining one from last week.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: mamaTobiId },
          obligation: { kind: 'id', obligationId: 'obligation-mama-tobi-1' },
          amountMinor: 3_000_000,
          settleRemaining: true,
          permittedMutation: true,
          evidence: ['She paid the remaining one from last week.'],
          source: { utterance: 'She paid the remaining one from last week.', language: 'en' },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, mamaTobiId, 'Mama Tobi'),
          obligations: [
            {
              id: 'obligation-mama-tobi-1',
              customerId: mamaTobiId,
              customerName: 'Mama Tobi',
              originalAmountMinor: 5_000_000,
              totalPaidMinor: 5_000_000,
              outstandingMinor: 0,
              status: 'settled',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: ['seed'],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
        notes:
          'The pronoun and temporal reference require context-aware resolution. Review whether the seed should include earlier turns explicitly.',
      },
    ],
  }),
  seedScenario({
    id: 'ambiguous-identity-abstain',
    title: 'Ambiguous same-name debtor',
    purpose: 'Abstain when multiple customers share the same name and mutation would be unsafe.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Musa paid 10k.',
        language: 'en',
        expectedAction: ledgerActionSchema.parse({
          type: 'REQUEST_CLARIFICATION',
          question: 'Which Musa did you mean?',
          ambiguityKind: 'customer',
          candidateCustomerIds: [musaOneId, musaTwoId],
          candidateObligationIds: [],
          permittedMutation: false,
          evidence: ['Musa paid 10k.'],
          source: { utterance: 'Musa paid 10k.', language: 'en' },
        }),
        expectedSnapshot: {
          ...createCustomer(baseDocument, baseSnapshot, musaOneId, 'Musa'),
          customers: [
            {
              id: musaOneId,
              displayName: 'Musa',
              aliases: [],
              normalizedNames: ['musa'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
            {
              id: musaTwoId,
              displayName: 'Musa',
              aliases: [],
              normalizedNames: ['musa'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-musa-1',
              customerId: musaOneId,
              customerName: 'Musa',
              originalAmountMinor: 2_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 2_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
            {
              id: 'obligation-musa-2',
              customerId: musaTwoId,
              customerName: 'Musa',
              originalAmountMinor: 4_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 4_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: false,
        notes: 'This is a hard abstention case and must not change financial state.',
      },
    ],
  }),
  seedScenario({
    id: 'pidgin-multi-turn',
    title: 'Nigerian Pidgin multi-turn scenario',
    purpose: 'Combine creation, partial payment, correction, and clarification behavior in Pidgin.',
    reviewStatus: 'draft-review',
    turns: [
      {
        id: 'turn-1',
        inputText: 'Aunty Sade take 30k goods yesterday.',
        language: 'pcm',
        expectedAction: ledgerActionSchema.parse({
          type: 'CREATE_OBLIGATION',
          customer: { kind: 'new', name: 'Aunty Sade', aliases: [] },
          amountMinor: 3_000_000,
          permittedMutation: true,
          evidence: ['Aunty Sade take 30k goods yesterday.'],
          source: { utterance: 'Aunty Sade take 30k goods yesterday.', language: 'pcm' },
        }),
        expectedSnapshot: {
          ...baseSnapshot,
          customers: [
            {
              id: 'customer-aunty-sade',
              displayName: 'Aunty Sade',
              aliases: [],
              normalizedNames: ['aunty sade'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-aunty-sade-1',
              customerId: 'customer-aunty-sade',
              customerName: 'Aunty Sade',
              originalAmountMinor: 3_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 3_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
      },
      {
        id: 'turn-2',
        inputText: 'She bring 10 today.',
        language: 'pcm',
        expectedAction: ledgerActionSchema.parse({
          type: 'RECORD_PAYMENT',
          customer: { kind: 'id', customerId: 'customer-aunty-sade' },
          obligation: { kind: 'id', obligationId: 'obligation-aunty-sade-1' },
          amountMinor: 1_000_000,
          settleRemaining: false,
          permittedMutation: true,
          evidence: ['She bring 10 today.'],
          source: { utterance: 'She bring 10 today.', language: 'pcm' },
        }),
        expectedSnapshot: {
          ...baseSnapshot,
          customers: [
            {
              id: 'customer-aunty-sade',
              displayName: 'Aunty Sade',
              aliases: [],
              normalizedNames: ['aunty sade'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-aunty-sade-1',
              customerId: 'customer-aunty-sade',
              customerName: 'Aunty Sade',
              originalAmountMinor: 3_000_000,
              totalPaidMinor: 1_000_000,
              outstandingMinor: 2_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: ['seed'],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: true,
        notes:
          'The parser should treat bare 10 as 10,000 NGN in this scenario, but this detail still needs review.',
      },
      {
        id: 'turn-3',
        inputText: 'No, e no be 30. Na 45k.',
        language: 'pcm',
        expectedAction: ledgerActionSchema.parse({
          type: 'CORRECT_OBLIGATION',
          obligation: { kind: 'id', obligationId: 'obligation-aunty-sade-1' },
          correctedAmountMinor: 4_500_000,
          correctionReason: 'Corrected previous debt amount',
          permittedMutation: true,
          evidence: ['No, e no be 30. Na 45k.'],
          source: { utterance: 'No, e no be 30. Na 45k.', language: 'pcm' },
        }),
        expectedSnapshot: {
          ...baseSnapshot,
          customers: [
            {
              id: 'customer-aunty-sade',
              displayName: 'Aunty Sade',
              aliases: [],
              normalizedNames: ['aunty sade'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-aunty-sade-1',
              customerId: 'customer-aunty-sade',
              customerName: 'Aunty Sade',
              originalAmountMinor: 4_500_000,
              totalPaidMinor: 1_000_000,
              outstandingMinor: 3_500_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: ['seed'],
              correctionEventIds: ['seed'],
            },
          ],
        },
        expectMutation: true,
      },
      {
        id: 'turn-4',
        inputText: 'Musa pay 10k.',
        language: 'pcm',
        expectedAction: ledgerActionSchema.parse({
          type: 'REQUEST_CLARIFICATION',
          question: 'Which Musa did you mean?',
          ambiguityKind: 'customer',
          candidateCustomerIds: [musaOneId, musaTwoId],
          candidateObligationIds: [],
          permittedMutation: false,
          evidence: ['Musa pay 10k.'],
          source: { utterance: 'Musa pay 10k.', language: 'pcm' },
        }),
        expectedSnapshot: {
          ...baseSnapshot,
          customers: [
            {
              id: musaOneId,
              displayName: 'Musa',
              aliases: [],
              normalizedNames: ['musa'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
            {
              id: musaTwoId,
              displayName: 'Musa',
              aliases: [],
              normalizedNames: ['musa'],
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              sourceEventIds: ['seed'],
            },
          ],
          obligations: [
            {
              id: 'obligation-musa-1',
              customerId: musaOneId,
              customerName: 'Musa',
              originalAmountMinor: 2_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 2_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
            {
              id: 'obligation-musa-2',
              customerId: musaTwoId,
              customerName: 'Musa',
              originalAmountMinor: 4_000_000,
              totalPaidMinor: 0,
              outstandingMinor: 4_000_000,
              status: 'open',
              createdAt: '2026-08-28T00:00:00.000Z',
              updatedAt: '2026-08-28T00:00:00.000Z',
              dueAt: null,
              sourceEventIds: ['seed'],
              paymentEventIds: [],
              correctionEventIds: [],
            },
          ],
        },
        expectMutation: false,
      },
    ],
  }),
];

export { scenarios as seedScenarios };
