import { AdvancedInterpreter, BaselineInterpreter } from '../interpreters.js';
import { evaluateScenario } from './evaluator.js';
import { seedScenarios } from './scenarios.js';

const mode = process.env.TALLI_INTERPRETER_MODE === 'advanced' ? 'advanced' : 'baseline';
const interpreter = mode === 'advanced' ? new AdvancedInterpreter() : new BaselineInterpreter();

async function main() {
  const results = [];
  for (const scenario of seedScenarios) {
    results.push(await evaluateScenario(scenario, interpreter));
  }

  console.log(
    JSON.stringify(
      {
        mode,
        results: results.map((result) => ({
          scenarioId: result.scenarioId,
          lsa: result.lsa,
          umr: result.umr,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
