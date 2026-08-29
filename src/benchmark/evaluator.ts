import type { LedgerAction } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  applyLedgerAction,
  assertLedgerInvariants,
  projectLedger,
} from '../domain/ledger.js';
import type { ActionInterpreter } from '../interpreters.js';
import { BENCHMARK_CLOCK, type BenchmarkScenario, createBenchmarkContext } from './scenarios.js';

export interface CanonicalCustomer {
  id: string;
  displayName: string;
  aliases: string[];
}

export interface CanonicalObligation {
  id: string;
  customerId: string;
  customerName: string;
  originalAmountMinor: number;
  totalPaidMinor: number;
  outstandingMinor: number;
  status: 'open' | 'settled';
  dueAt: string | null;
}

export interface CanonicalLedgerSnapshot {
  id: string;
  currency: LedgerSnapshot['currency'];
  customers: CanonicalCustomer[];
  obligations: CanonicalObligation[];
  totals: LedgerSnapshot['totals'];
}

export interface CanonicalCustomerRef {
  kind: 'new' | 'id' | 'name' | 'ambiguous';
  name?: string;
  aliases?: string[];
  allowCreate?: boolean;
  customerId?: string;
  candidateCustomerIds?: string[];
}

export interface CanonicalObligationRef {
  kind: 'id' | 'latestOpenForCustomer' | 'latestForCustomer' | 'reference' | 'ambiguous';
  customer?: CanonicalCustomerRef;
  obligationId?: string;
  phrase?: string;
  previousTurnId?: string | null;
  candidateObligationIds?: string[];
}

export interface CanonicalLedgerAction {
  type: LedgerAction['type'];
  permittedMutation: boolean;
  customer: CanonicalCustomerRef | null;
  obligation: CanonicalObligationRef | null;
  amountMinor: number | null;
  correctedAmountMinor: number | null;
  settleRemaining: boolean | null;
  dueAt: string | null;
  ambiguityKind: string | null;
  candidateCustomerIds: string[];
  candidateObligationIds: string[];
}

export interface TurnEvaluation {
  turnId: string;
  inputText: string;
  language: 'en' | 'pcm' | 'mixed';
  expectedAction: LedgerAction;
  actualAction: LedgerAction;
  expectedCanonicalAction: CanonicalLedgerAction;
  actualCanonicalAction: CanonicalLedgerAction;
  expectedSnapshot: LedgerSnapshot;
  actualSnapshot: LedgerSnapshot;
  expectedCanonicalSnapshot: CanonicalLedgerSnapshot;
  actualCanonicalSnapshot: CanonicalLedgerSnapshot;
  expectMutation: boolean;
  mutationOccurred: boolean;
  clarificationOccurred: boolean;
  stateMatch: boolean;
  actionMatch: boolean;
  unsafeMutation: boolean;
}

export interface ScenarioEvaluation {
  scenarioId: string;
  title: string;
  purpose: string;
  turns: TurnEvaluation[];
  lsa: number;
  actionAccuracy: number;
  abstentionRequiredTurnCount: number;
  unsafeMutationCount: number;
  umr: number | null;
}

export interface BenchmarkEvaluation {
  mode: string;
  referenceNow: string;
  timezone: string;
  scenarioCount: number;
  turnCount: number;
  scenarios: ScenarioEvaluation[];
  lsa: number;
  actionAccuracy: number;
  abstentionRequiredTurnCount: number;
  unsafeMutationCount: number;
  umr: number | null;
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function canonicalizeCustomerRefValue(ref: unknown): CanonicalCustomerRef | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const record = ref as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'new' && kind !== 'id' && kind !== 'name' && kind !== 'ambiguous') {
    return null;
  }

  if (kind === 'new') {
    return {
      kind,
      name: typeof record.name === 'string' ? record.name : undefined,
      aliases: Array.isArray(record.aliases)
        ? sortStrings(record.aliases.filter((value): value is string => typeof value === 'string'))
        : [],
    };
  }

  if (kind === 'id') {
    return {
      kind,
      customerId: typeof record.customerId === 'string' ? record.customerId : undefined,
    };
  }

  if (kind === 'name') {
    return {
      kind,
      name: typeof record.name === 'string' ? record.name : undefined,
      allowCreate: typeof record.allowCreate === 'boolean' ? record.allowCreate : true,
    };
  }

  return {
    kind,
    name: typeof record.name === 'string' ? record.name : undefined,
    candidateCustomerIds: Array.isArray(record.candidateCustomerIds)
      ? sortStrings(
          record.candidateCustomerIds.filter((value): value is string => typeof value === 'string'),
        )
      : [],
  };
}

function canonicalizeObligationRefValue(ref: unknown): CanonicalObligationRef | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const record = ref as Record<string, unknown>;
  const kind = record.kind;
  if (
    kind !== 'id' &&
    kind !== 'latestOpenForCustomer' &&
    kind !== 'latestForCustomer' &&
    kind !== 'reference' &&
    kind !== 'ambiguous'
  ) {
    return null;
  }

  if (kind === 'id') {
    return {
      kind,
      obligationId: typeof record.obligationId === 'string' ? record.obligationId : undefined,
    };
  }

  if (kind === 'latestOpenForCustomer' || kind === 'latestForCustomer') {
    return {
      kind,
      customer: canonicalizeCustomerRefValue(record.customer) ?? undefined,
    };
  }

  if (kind === 'reference') {
    return {
      kind,
      phrase: typeof record.phrase === 'string' ? record.phrase : undefined,
      previousTurnId: typeof record.previousTurnId === 'string' ? record.previousTurnId : null,
    };
  }

  return {
    kind,
    phrase: typeof record.phrase === 'string' ? record.phrase : undefined,
    candidateObligationIds: Array.isArray(record.candidateObligationIds)
      ? sortStrings(
          record.candidateObligationIds.filter(
            (value): value is string => typeof value === 'string',
          ),
        )
      : [],
  };
}

export function canonicalizeLedgerAction(action: LedgerAction): CanonicalLedgerAction {
  switch (action.type) {
    case 'CREATE_OBLIGATION':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: canonicalizeCustomerRefValue(action.customer),
        obligation: null,
        amountMinor: action.amountMinor,
        correctedAmountMinor: null,
        settleRemaining: null,
        dueAt: action.dueAt ?? null,
        ambiguityKind: null,
        candidateCustomerIds: [],
        candidateObligationIds: [],
      };
    case 'RECORD_PAYMENT':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: action.customer ? canonicalizeCustomerRefValue(action.customer) : null,
        obligation: action.obligation ? canonicalizeObligationRefValue(action.obligation) : null,
        amountMinor: action.amountMinor ?? null,
        correctedAmountMinor: null,
        settleRemaining: action.settleRemaining,
        dueAt: null,
        ambiguityKind: null,
        candidateCustomerIds: [],
        candidateObligationIds: [],
      };
    case 'CORRECT_OBLIGATION':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: null,
        obligation: canonicalizeObligationRefValue(action.obligation),
        amountMinor: null,
        correctedAmountMinor: action.correctedAmountMinor,
        settleRemaining: null,
        dueAt: null,
        ambiguityKind: null,
        candidateCustomerIds: [],
        candidateObligationIds: [],
      };
    case 'SETTLE_OBLIGATION':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: null,
        obligation: canonicalizeObligationRefValue(action.obligation),
        amountMinor: action.amountMinor ?? null,
        correctedAmountMinor: null,
        settleRemaining: null,
        dueAt: null,
        ambiguityKind: null,
        candidateCustomerIds: [],
        candidateObligationIds: [],
      };
    case 'REQUEST_CLARIFICATION':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: null,
        obligation: null,
        amountMinor: null,
        correctedAmountMinor: null,
        settleRemaining: null,
        dueAt: null,
        ambiguityKind: action.ambiguityKind ?? null,
        candidateCustomerIds: sortStrings(action.candidateCustomerIds),
        candidateObligationIds: sortStrings(action.candidateObligationIds),
      };
    case 'NO_ACTION':
      return {
        type: action.type,
        permittedMutation: action.permittedMutation,
        customer: null,
        obligation: null,
        amountMinor: null,
        correctedAmountMinor: null,
        settleRemaining: null,
        dueAt: null,
        ambiguityKind: null,
        candidateCustomerIds: [],
        candidateObligationIds: [],
      };
    default: {
      const never: never = action;
      return never;
    }
  }
}

export function canonicalizeLedgerSnapshot(snapshot: LedgerSnapshot): CanonicalLedgerSnapshot {
  return {
    id: snapshot.id,
    currency: snapshot.currency,
    customers: [...snapshot.customers]
      .map((customer) => ({
        id: customer.id,
        displayName: customer.displayName,
        aliases: sortStrings(customer.aliases),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    obligations: [...snapshot.obligations]
      .map((obligation) => ({
        id: obligation.id,
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        originalAmountMinor: obligation.originalAmountMinor,
        totalPaidMinor: obligation.totalPaidMinor,
        outstandingMinor: obligation.outstandingMinor,
        status: obligation.status,
        dueAt: obligation.dueAt ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    totals: {
      openOutstandingMinor: snapshot.totals.openOutstandingMinor,
      settledOutstandingMinor: snapshot.totals.settledOutstandingMinor,
      totalPaidMinor: snapshot.totals.totalPaidMinor,
    },
  };
}

export function canonicalSnapshotsEqual(
  left: LedgerSnapshot | CanonicalLedgerSnapshot,
  right: LedgerSnapshot | CanonicalLedgerSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function canonicalActionsEqual(left: LedgerAction, right: LedgerAction): boolean {
  return (
    JSON.stringify(canonicalizeLedgerAction(left)) ===
    JSON.stringify(canonicalizeLedgerAction(right))
  );
}

export function diffCanonicalSnapshots(
  expected: CanonicalLedgerSnapshot,
  actual: CanonicalLedgerSnapshot,
): string[] {
  const diffs: string[] = [];

  if (expected.currency !== actual.currency) {
    diffs.push(`currency expected ${expected.currency} but got ${actual.currency}`);
  }

  for (const key of Object.keys(expected.totals) as (keyof CanonicalLedgerSnapshot['totals'])[]) {
    if (expected.totals[key] !== actual.totals[key]) {
      diffs.push(`totals.${key} expected ${expected.totals[key]} but got ${actual.totals[key]}`);
    }
  }

  const expectedCustomers = new Map(expected.customers.map((customer) => [customer.id, customer]));
  const actualCustomers = new Map(actual.customers.map((customer) => [customer.id, customer]));
  const customerIds = new Set([...expectedCustomers.keys(), ...actualCustomers.keys()]);
  for (const customerId of [...customerIds].sort()) {
    const expectedCustomer = expectedCustomers.get(customerId);
    const actualCustomer = actualCustomers.get(customerId);
    if (!expectedCustomer) {
      diffs.push(`unexpected customer ${customerId} in actual snapshot`);
      continue;
    }
    if (!actualCustomer) {
      diffs.push(`missing customer ${customerId} in actual snapshot`);
      continue;
    }
    if (JSON.stringify(expectedCustomer) !== JSON.stringify(actualCustomer)) {
      diffs.push(
        `customer ${customerId} expected ${JSON.stringify(expectedCustomer)} but got ${JSON.stringify(actualCustomer)}`,
      );
    }
  }

  const expectedObligations = new Map(
    expected.obligations.map((obligation) => [obligation.id, obligation]),
  );
  const actualObligations = new Map(
    actual.obligations.map((obligation) => [obligation.id, obligation]),
  );
  const obligationIds = new Set([...expectedObligations.keys(), ...actualObligations.keys()]);
  for (const obligationId of [...obligationIds].sort()) {
    const expectedObligation = expectedObligations.get(obligationId);
    const actualObligation = actualObligations.get(obligationId);
    if (!expectedObligation) {
      diffs.push(`unexpected obligation ${obligationId} in actual snapshot`);
      continue;
    }
    if (!actualObligation) {
      diffs.push(`missing obligation ${obligationId} in actual snapshot`);
      continue;
    }
    if (JSON.stringify(expectedObligation) !== JSON.stringify(actualObligation)) {
      diffs.push(
        `obligation ${obligationId} expected ${JSON.stringify(expectedObligation)} but got ${JSON.stringify(actualObligation)}`,
      );
    }
  }

  return diffs;
}

function evaluateTurn(
  scenario: BenchmarkScenario,
  document: LedgerDocument,
  turnId: string,
  inputText: string,
  language: 'en' | 'pcm' | 'mixed',
  interpreter: ActionInterpreter,
  recentTexts: string[],
  expectedAction: LedgerAction,
  expectedSnapshot: LedgerSnapshot,
  expectMutation: boolean,
): Promise<{ document: LedgerDocument; evaluation: TurnEvaluation }> {
  const currentSnapshot = projectLedger(document);
  const benchmark = {
    scenarioId: scenario.id,
    turnId,
    referenceNow: BENCHMARK_CLOCK.referenceNow,
    timezone: BENCHMARK_CLOCK.timezone,
  };

  return interpreter
    .interpret(
      interpreter.kind === 'advanced'
        ? {
            text: inputText,
            language,
            benchmark,
            snapshot: currentSnapshot,
            recentTexts,
          }
        : {
            text: inputText,
            language,
            benchmark,
          },
    )
    .then((actualAction) => {
      const context = createBenchmarkContext(scenario.id, turnId, inputText);
      const result = applyLedgerAction(document, actualAction, context);
      const actualSnapshot = projectLedger(result.document);
      const expectedCanonicalSnapshot = canonicalizeLedgerSnapshot(expectedSnapshot);
      const actualCanonicalSnapshot = canonicalizeLedgerSnapshot(actualSnapshot);
      const stateMatch = canonicalSnapshotsEqual(
        expectedCanonicalSnapshot,
        actualCanonicalSnapshot,
      );
      const actionMatch = canonicalActionsEqual(expectedAction, actualAction);

      assertLedgerInvariants(actualSnapshot);

      return {
        document: result.document,
        evaluation: {
          turnId,
          inputText,
          language,
          expectedAction,
          actualAction,
          expectedCanonicalAction: canonicalizeLedgerAction(expectedAction),
          actualCanonicalAction: canonicalizeLedgerAction(actualAction),
          expectedSnapshot,
          actualSnapshot,
          expectedCanonicalSnapshot,
          actualCanonicalSnapshot,
          expectMutation,
          mutationOccurred: result.financialMutation,
          clarificationOccurred: Boolean(result.clarification),
          stateMatch,
          actionMatch,
          unsafeMutation: !expectMutation && result.financialMutation,
        },
      };
    });
}

export async function evaluateScenario(
  scenario: BenchmarkScenario,
  interpreter: ActionInterpreter,
): Promise<ScenarioEvaluation> {
  let document: LedgerDocument = {
    ...scenario.startingDocument,
    events: [...scenario.startingDocument.events],
  };

  const startingSnapshot = projectLedger(document);
  assertLedgerInvariants(startingSnapshot);

  const evaluations: TurnEvaluation[] = [];
  const recentTexts: string[] = [];

  for (const turn of scenario.turns) {
    const outcome = await evaluateTurn(
      scenario,
      document,
      turn.id,
      turn.inputText,
      turn.language,
      interpreter,
      recentTexts,
      turn.expectedAction,
      turn.expectedSnapshot,
      turn.expectMutation,
    );

    document = outcome.document;
    evaluations.push(outcome.evaluation);
    recentTexts.push(turn.inputText);
  }

  const stateMatches = evaluations.filter((evaluation) => evaluation.stateMatch).length;
  const actionMatches = evaluations.filter((evaluation) => evaluation.actionMatch).length;
  const abstentionRequiredTurnCount = evaluations.filter(
    (evaluation) => !evaluation.expectMutation,
  ).length;
  const unsafeMutationCount = evaluations.filter((evaluation) => evaluation.unsafeMutation).length;

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    purpose: scenario.purpose,
    turns: evaluations,
    lsa: evaluations.length === 0 ? 1 : stateMatches / evaluations.length,
    actionAccuracy: evaluations.length === 0 ? 1 : actionMatches / evaluations.length,
    abstentionRequiredTurnCount,
    unsafeMutationCount,
    umr:
      abstentionRequiredTurnCount === 0 ? null : unsafeMutationCount / abstentionRequiredTurnCount,
  };
}

export async function evaluateBenchmark(
  scenarios: readonly BenchmarkScenario[],
  interpreter: ActionInterpreter,
  mode: string = interpreter.kind,
): Promise<BenchmarkEvaluation> {
  const results: ScenarioEvaluation[] = [];
  for (const scenario of scenarios) {
    results.push(await evaluateScenario(scenario, interpreter));
  }

  const turnCount = results.reduce((count, scenario) => count + scenario.turns.length, 0);
  const stateMatches = results.reduce(
    (count, scenario) => count + scenario.turns.filter((turn) => turn.stateMatch).length,
    0,
  );
  const actionMatches = results.reduce(
    (count, scenario) => count + scenario.turns.filter((turn) => turn.actionMatch).length,
    0,
  );
  const abstentionRequiredTurnCount = results.reduce(
    (count, scenario) => count + scenario.abstentionRequiredTurnCount,
    0,
  );
  const unsafeMutationCount = results.reduce(
    (count, scenario) => count + scenario.unsafeMutationCount,
    0,
  );

  return {
    mode,
    referenceNow: BENCHMARK_CLOCK.referenceNow,
    timezone: BENCHMARK_CLOCK.timezone,
    scenarioCount: results.length,
    turnCount,
    scenarios: results,
    lsa: turnCount === 0 ? 1 : stateMatches / turnCount,
    actionAccuracy: turnCount === 0 ? 1 : actionMatches / turnCount,
    abstentionRequiredTurnCount,
    unsafeMutationCount,
    umr:
      abstentionRequiredTurnCount === 0 ? null : unsafeMutationCount / abstentionRequiredTurnCount,
  };
}
