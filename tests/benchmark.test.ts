import { describe, expect, it } from 'vitest';
import {
  IntentionallyWrongInterpreter,
  PerfectFixtureInterpreter,
  UnsafeMutationInterpreter,
} from '../src/benchmark/control-interpreters.js';
import {
  canonicalSnapshotsEqual,
  canonicalizeLedgerSnapshot,
  evaluateBenchmark,
  evaluateScenario,
} from '../src/benchmark/evaluator.js';
import {
  BENCHMARK_REFERENCE_NOW,
  BENCHMARK_TIMEZONE,
  seedScenarios,
} from '../src/benchmark/scenarios.js';
import { assertLedgerInvariants } from '../src/domain/ledger.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertMinorUnitFields(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertMinorUnitFields(entry, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith('Minor')) {
      expect(typeof child).toBe('number');
      expect(Number.isInteger(child)).toBe(true);
    }
    assertMinorUnitFields(child, `${path}.${key}`);
  }
}

function getScenario(id: string) {
  const scenario = seedScenarios.find((entry) => entry.id === id);
  expect(scenario).toBeDefined();
  if (!scenario) {
    throw new Error(`Expected benchmark scenario ${id} to exist.`);
  }
  return scenario;
}

describe('benchmark fixtures', () => {
  it('locks exactly eight scenarios with deterministic clocks and valid expected states', () => {
    expect(seedScenarios).toHaveLength(8);
    expect(new Set(seedScenarios.map((scenario) => scenario.id)).size).toBe(8);

    for (const scenario of seedScenarios) {
      expect(scenario.status).toBe('locked');
      expect(scenario.clock.referenceNow).toBe(BENCHMARK_REFERENCE_NOW);
      expect(scenario.clock.timezone).toBe(BENCHMARK_TIMEZONE);
      expect(scenario.turns.length).toBeGreaterThan(0);
      assertLedgerInvariants(scenario.startingSnapshot);
      assertMinorUnitFields(scenario.startingSnapshot);

      for (const turn of scenario.turns) {
        expect(turn.inputText).toBeTruthy();
        expect(turn.evaluatorNotes).toBeTruthy();
        assertLedgerInvariants(turn.expectedSnapshot);
        assertMinorUnitFields(turn.expectedSnapshot);
        assertMinorUnitFields(turn.expectedAction);
      }
    }
  });

  it('canonical comparison ignores audit metadata but catches economic changes', () => {
    const scenario = getScenario('simple-new-credit');
    const turn = scenario.turns[0];
    expect(turn).toBeDefined();
    if (!turn) {
      throw new Error('Expected the simple-new-credit scenario to have one turn.');
    }

    const snapshot = canonicalizeLedgerSnapshot(turn.expectedSnapshot);
    const sameEconomics = clone(turn.expectedSnapshot);
    if (sameEconomics.customers[0]) {
      sameEconomics.customers[0].createdAt = '1999-01-01T00:00:00.000Z';
      sameEconomics.customers[0].updatedAt = '1999-01-02T00:00:00.000Z';
      sameEconomics.customers[0].sourceEventIds = ['different'];
    }
    if (sameEconomics.obligations[0]) {
      sameEconomics.obligations[0].createdAt = '1999-01-01T00:00:00.000Z';
      sameEconomics.obligations[0].updatedAt = '1999-01-02T00:00:00.000Z';
      sameEconomics.obligations[0].sourceEventIds = ['different'];
    }

    expect(canonicalSnapshotsEqual(snapshot, canonicalizeLedgerSnapshot(sameEconomics))).toBe(true);

    const changedEconomics = clone(turn.expectedSnapshot);
    if (changedEconomics.obligations[0]) {
      changedEconomics.obligations[0].outstandingMinor += 100;
    }
    expect(canonicalSnapshotsEqual(snapshot, canonicalizeLedgerSnapshot(changedEconomics))).toBe(
      false,
    );
  });

  it('perfect control scores 100% on the locked benchmark', async () => {
    const evaluation = await evaluateBenchmark(
      seedScenarios,
      new PerfectFixtureInterpreter(seedScenarios),
      'perfect',
    );

    expect(evaluation.scenarioCount).toBe(8);
    expect(evaluation.turnCount).toBeGreaterThan(0);
    expect(evaluation.lsa).toBe(1);
    expect(evaluation.actionAccuracy).toBe(1);
    expect(evaluation.abstentionRequiredTurnCount).toBeGreaterThan(0);
    expect(evaluation.unsafeMutationCount).toBe(0);
    expect(evaluation.umr).toBe(0);
    expect(evaluation.scenarios.every((scenario) => scenario.lsa === 1)).toBe(true);
    expect(evaluation.scenarios.every((scenario) => scenario.actionAccuracy === 1)).toBe(true);
  });

  it('wrong control reduces accuracy without triggering unsafe mutations', async () => {
    const evaluation = await evaluateBenchmark(
      seedScenarios,
      new IntentionallyWrongInterpreter(seedScenarios),
      'wrong',
    );

    expect(evaluation.lsa).toBeLessThan(1);
    expect(evaluation.actionAccuracy).toBeLessThan(1);
    expect(
      evaluation.scenarios.some((scenario) => scenario.turns.some((turn) => !turn.actionMatch)),
    ).toBe(true);
  });

  it('unsafe control produces a non-zero unsafe mutation rate', async () => {
    const evaluation = await evaluateBenchmark(
      seedScenarios,
      new UnsafeMutationInterpreter(seedScenarios),
      'unsafe',
    );

    expect(evaluation.abstentionRequiredTurnCount).toBeGreaterThan(0);
    expect(evaluation.unsafeMutationCount).toBeGreaterThan(0);
    expect(evaluation.umr).not.toBeNull();
    expect(evaluation.umr ?? 0).toBeGreaterThan(0);
  });

  it('abstention-required turns preserve the pre-turn financial state', async () => {
    const scenario = getScenario('ambiguous-customer-abstain');
    const result = await evaluateScenario(scenario, new PerfectFixtureInterpreter(seedScenarios));
    const turn = result.turns[0];
    expect(turn).toBeDefined();
    if (!turn) {
      throw new Error('Expected the ambiguous-customer-abstain scenario to have one turn.');
    }

    expect(turn.expectMutation).toBe(false);
    expect(turn.mutationOccurred).toBe(false);
    expect(turn.clarificationOccurred).toBe(true);
    expect(turn.stateMatch).toBe(true);
    expect(turn.actionMatch).toBe(true);
    expect(
      canonicalSnapshotsEqual(
        canonicalizeLedgerSnapshot(turn.expectedSnapshot),
        canonicalizeLedgerSnapshot(turn.actualSnapshot),
      ),
    ).toBe(true);
  });

  it('the correction scenario preserves payment history in the resulting balance', async () => {
    const scenario = getScenario('correction');
    const result = await evaluateScenario(scenario, new PerfectFixtureInterpreter(seedScenarios));
    const turn = result.turns[2];
    expect(turn).toBeDefined();
    if (!turn) {
      throw new Error('Expected the correction scenario to have a third turn.');
    }

    const obligation = turn.actualSnapshot.obligations[0];
    expect(obligation).toBeDefined();
    if (!obligation) {
      throw new Error('Expected the correction scenario to contain one obligation.');
    }

    expect(obligation.originalAmountMinor).toBe(42_000 * 100);
    expect(obligation.totalPaidMinor).toBe(4_000 * 100);
    expect(obligation.outstandingMinor).toBe(38_000 * 100);
    expect(obligation.status).toBe('open');
  });

  it('the reference-resolution scenario resolves the earlier obligation and settles the correct balance', async () => {
    const scenario = getScenario('natural-reference-resolution');
    const result = await evaluateScenario(scenario, new PerfectFixtureInterpreter(seedScenarios));
    const turn = result.turns[2];
    expect(turn).toBeDefined();
    if (!turn) {
      throw new Error('Expected the natural-reference-resolution scenario to have a third turn.');
    }

    expect(turn.stateMatch).toBe(true);
    expect(turn.actionMatch).toBe(true);

    const bola = turn.actualSnapshot.obligations.find(
      (obligation) => obligation.customerName === 'Bola',
    );
    expect(bola).toBeDefined();
    if (!bola) {
      throw new Error('Expected the Bola obligation to exist.');
    }

    expect(bola.totalPaidMinor).toBe(5_000 * 100);
    expect(bola.outstandingMinor).toBe(13_000 * 100);
  });

  it('returns N/A UMR when a scenario has no abstention-required turns', async () => {
    const scenario = getScenario('simple-new-credit');
    const result = await evaluateScenario(scenario, new PerfectFixtureInterpreter(seedScenarios));
    expect(result.abstentionRequiredTurnCount).toBe(0);
    expect(result.umr).toBeNull();
  });
});
