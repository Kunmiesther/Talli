import { describe, expect, it } from 'vitest';
import { evaluateScenario } from '../src/benchmark/evaluator.js';
import { seedScenarios } from '../src/benchmark/scenarios.js';
import type { ActionInterpreter } from '../src/interpreters.js';

describe('benchmark fixtures', () => {
  it('ships eight draft-review scenarios', () => {
    expect(seedScenarios).toHaveLength(8);
    for (const scenario of seedScenarios) {
      expect(scenario.reviewStatus).toBe('draft-review');
      expect(scenario.turns.length).toBeGreaterThan(0);
    }
  });

  it('can run a scenario through the evaluation harness', async () => {
    const scenario = seedScenarios.find((entry) => entry.id === 'simple-new-debt');
    expect(scenario).toBeDefined();
    if (!scenario) {
      throw new Error('Expected the simple-new-debt seed scenario to exist.');
    }
    const firstTurn = scenario.turns[0];
    if (!firstTurn) {
      throw new Error('Expected the simple-new-debt scenario to have a first turn.');
    }

    const interpreter: ActionInterpreter = {
      kind: 'baseline',
      async interpret() {
        return firstTurn.expectedAction;
      },
    };

    const result = await evaluateScenario(scenario, interpreter);
    expect(result.scenarioId).toBe('simple-new-debt');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.actualAction.type).toBe(firstTurn.expectedAction.type);
    expect(result.lsa).toBeGreaterThanOrEqual(0);
    expect(result.umr).toBeGreaterThanOrEqual(0);
  });
});
