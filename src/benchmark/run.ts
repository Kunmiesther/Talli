import { AdvancedInterpreter, BaselineInterpreter } from '../interpreters.js';
import {
  IntentionallyWrongInterpreter,
  PerfectFixtureInterpreter,
  UnsafeMutationInterpreter,
} from './control-interpreters.js';
import {
  type canonicalizeLedgerAction,
  type canonicalizeLedgerSnapshot,
  diffCanonicalSnapshots,
  evaluateBenchmark,
} from './evaluator.js';
import { type BenchmarkScenario, seedScenarios } from './scenarios.js';

type BenchmarkOutputFormat = 'text' | 'json';
type InterpreterMode = 'baseline' | 'advanced' | 'perfect' | 'wrong' | 'unsafe';

function readInterpreterMode(): InterpreterMode {
  const mode = process.env.TALLI_INTERPRETER_MODE;
  if (
    mode === 'baseline' ||
    mode === 'advanced' ||
    mode === 'perfect' ||
    mode === 'wrong' ||
    mode === 'unsafe'
  ) {
    return mode;
  }

  return 'baseline';
}

function readOutputFormat(): BenchmarkOutputFormat {
  const output = process.env.TALLI_BENCHMARK_OUTPUT;
  return output === 'json' ? 'json' : 'text';
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return 'N/A';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatSummaryLine(label: string, value: string, indent = 0): string {
  return `${' '.repeat(indent)}${label}: ${value}`;
}

function renderScenarioFailures(scenario: {
  scenarioId: string;
  title: string;
  turns: Array<{
    turnId: string;
    inputText: string;
    expectedCanonicalAction: ReturnType<typeof canonicalizeLedgerAction>;
    actualCanonicalAction: ReturnType<typeof canonicalizeLedgerAction>;
    expectedCanonicalSnapshot: ReturnType<typeof canonicalizeLedgerSnapshot>;
    actualCanonicalSnapshot: ReturnType<typeof canonicalizeLedgerSnapshot>;
    stateMatch: boolean;
    actionMatch: boolean;
    unsafeMutation: boolean;
  }>;
}): string[] {
  const lines: string[] = [];
  const failedTurns = scenario.turns.filter(
    (turn) => !turn.stateMatch || !turn.actionMatch || turn.unsafeMutation,
  );

  for (const turn of failedTurns) {
    const diff = diffCanonicalSnapshots(
      turn.expectedCanonicalSnapshot,
      turn.actualCanonicalSnapshot,
    );
    lines.push(`  - Turn ${turn.turnId}`);
    lines.push(`    input: ${turn.inputText}`);
    lines.push(`    expected action: ${JSON.stringify(turn.expectedCanonicalAction, null, 2)}`);
    lines.push(`    actual action: ${JSON.stringify(turn.actualCanonicalAction, null, 2)}`);
    lines.push(
      `    canonical state diff: ${diff.length > 0 ? `\n      - ${diff.join('\n      - ')}` : 'none'}`,
    );
  }

  if (failedTurns.length === 0) {
    lines.push('  - none');
  }

  return lines;
}

function buildInterpreter(mode: InterpreterMode, scenarios: readonly BenchmarkScenario[]) {
  switch (mode) {
    case 'advanced':
      return new AdvancedInterpreter();
    case 'perfect':
      return new PerfectFixtureInterpreter(scenarios);
    case 'wrong':
      return new IntentionallyWrongInterpreter(scenarios);
    case 'unsafe':
      return new UnsafeMutationInterpreter(scenarios);
    default:
      return new BaselineInterpreter();
  }
}

async function main() {
  const mode = readInterpreterMode();
  const outputFormat = readOutputFormat();
  const interpreter = buildInterpreter(mode, seedScenarios);
  const evaluation = await evaluateBenchmark(seedScenarios, interpreter, mode);

  if (outputFormat === 'json') {
    console.log(JSON.stringify(evaluation, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(formatSummaryLine('mode', evaluation.mode));
  lines.push(formatSummaryLine('referenceNow', evaluation.referenceNow));
  lines.push(formatSummaryLine('timezone', evaluation.timezone));
  lines.push(formatSummaryLine('scenarioCount', String(evaluation.scenarioCount)));
  lines.push(formatSummaryLine('turnCount', String(evaluation.turnCount)));
  lines.push(formatSummaryLine('LSA', formatPercent(evaluation.lsa)));
  lines.push(formatSummaryLine('Action Accuracy', formatPercent(evaluation.actionAccuracy)));
  lines.push(
    formatSummaryLine(
      'abstentionRequiredTurnCount',
      String(evaluation.abstentionRequiredTurnCount),
    ),
  );
  lines.push(formatSummaryLine('unsafeMutationCount', String(evaluation.unsafeMutationCount)));
  lines.push(formatSummaryLine('UMR', formatPercent(evaluation.umr)));
  lines.push('');

  for (const scenario of evaluation.scenarios) {
    lines.push(
      `${scenario.scenarioId} | ${scenario.title} | turns=${scenario.turns.length} | LSA=${formatPercent(scenario.lsa)} | Action Accuracy=${formatPercent(scenario.actionAccuracy)} | Unsafe Mutation=${scenario.unsafeMutationCount}`,
    );
    lines.push(...renderScenarioFailures(scenario));
    lines.push('');
  }

  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
