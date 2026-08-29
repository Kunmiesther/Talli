import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import { type LedgerSnapshot, createLedgerDocument, projectLedger } from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';
import type {
  ActionInterpreter,
  AdvancedInterpreterInput,
  InterpreterInput,
  InterpreterRunDiagnostics,
} from '../interpreters.js';
import type { BenchmarkScenario } from './scenarios.js';

function cloneAction(action: LedgerAction): LedgerAction {
  return ledgerActionSchema.parse(JSON.parse(JSON.stringify(action)));
}

function readBenchmarkKeys(input: InterpreterInput | AdvancedInterpreterInput): {
  scenarioId?: string;
  turnId?: string;
} {
  return {
    scenarioId: input.benchmark?.scenarioId,
    turnId: input.benchmark?.turnId,
  };
}

function buildTurnIndex(
  scenarios: readonly BenchmarkScenario[],
): Map<string, Map<string, LedgerAction>> {
  const index = new Map<string, Map<string, LedgerAction>>();
  for (const scenario of scenarios) {
    const turnIndex = new Map<string, LedgerAction>();
    for (const turn of scenario.turns) {
      turnIndex.set(turn.id, turn.expectedAction);
    }
    index.set(scenario.id, turnIndex);
  }
  return index;
}

function createUnsafeMutationAction(snapshot: LedgerSnapshot): LedgerAction {
  const openObligation = snapshot.obligations.find((obligation) => obligation.status === 'open');
  if (openObligation) {
    return ledgerActionSchema.parse({
      type: 'RECORD_PAYMENT',
      customer: { kind: 'id', customerId: openObligation.customerId },
      obligation: { kind: 'id', obligationId: openObligation.id },
      amountMinor: Math.min(openObligation.outstandingMinor, nairaToMinorUnits(10_000)),
      settleRemaining: false,
      permittedMutation: true,
      evidence: ['unsafe-mutation-control'],
      source: { utterance: 'unsafe-mutation-control', language: 'en' },
    });
  }

  return ledgerActionSchema.parse({
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name: 'Control Customer', aliases: [] },
    amountMinor: nairaToMinorUnits(10_000),
    permittedMutation: true,
    evidence: ['unsafe-mutation-control'],
    source: { utterance: 'unsafe-mutation-control', language: 'en' },
  });
}

export class PerfectFixtureInterpreter implements ActionInterpreter {
  kind = 'advanced' as const;
  lastDiagnostics: InterpreterRunDiagnostics | null = null;

  private readonly turnIndex: Map<string, Map<string, LedgerAction>>;

  constructor(scenarios: readonly BenchmarkScenario[]) {
    this.turnIndex = buildTurnIndex(scenarios);
  }

  async interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction> {
    const { scenarioId, turnId } = readBenchmarkKeys(input);
    if (!scenarioId || !turnId) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'Missing benchmark context.',
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    const action = this.turnIndex.get(scenarioId)?.get(turnId);
    if (!action) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: `No benchmark action registered for ${scenarioId}/${turnId}.`,
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    return cloneAction(action);
  }
}

export class IntentionallyWrongInterpreter implements ActionInterpreter {
  kind = 'advanced' as const;
  lastDiagnostics: InterpreterRunDiagnostics | null = null;

  private readonly turnIndex: Map<string, Map<string, LedgerAction>>;

  constructor(scenarios: readonly BenchmarkScenario[]) {
    this.turnIndex = buildTurnIndex(scenarios);
  }

  async interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction> {
    const { scenarioId, turnId } = readBenchmarkKeys(input);
    if (!scenarioId || !turnId) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'Missing benchmark context.',
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    const expected = this.turnIndex.get(scenarioId)?.get(turnId);
    if (!expected) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: `No benchmark action registered for ${scenarioId}/${turnId}.`,
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    return ledgerActionSchema.parse({
      type: 'NO_ACTION',
      reason: `Intentionally wrong control output for ${expected.type}.`,
      permittedMutation: false,
      evidence: [input.text],
      source: { utterance: input.text, language: input.language ?? 'en' },
    });
  }
}

export class UnsafeMutationInterpreter implements ActionInterpreter {
  kind = 'advanced' as const;
  lastDiagnostics: InterpreterRunDiagnostics | null = null;

  private readonly turnIndex: Map<string, Map<string, LedgerAction>>;

  constructor(scenarios: readonly BenchmarkScenario[]) {
    this.turnIndex = buildTurnIndex(scenarios);
  }

  async interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction> {
    const { scenarioId, turnId } = readBenchmarkKeys(input);
    if (!scenarioId || !turnId) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'Missing benchmark context.',
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    const expected = this.turnIndex.get(scenarioId)?.get(turnId);
    if (!expected) {
      return ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: `No benchmark action registered for ${scenarioId}/${turnId}.`,
        permittedMutation: false,
        evidence: [input.text],
        source: { utterance: input.text, language: input.language ?? 'en' },
      });
    }

    if (expected.type === 'REQUEST_CLARIFICATION' || expected.type === 'NO_ACTION') {
      const snapshot = 'snapshot' in input ? input.snapshot : projectLedger(createLedgerDocument());
      return createUnsafeMutationAction(snapshot);
    }

    return cloneAction(expected);
  }
}
