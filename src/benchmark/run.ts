import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdvancedInterpreter, BaselineInterpreter } from '../interpreters.js';
import { createConfiguredStructuredActionModel } from '../llm/structured-action-model.js';
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
    mode === 'unsafe' ||
    mode === 'unsaf'
  ) {
    return mode === 'unsaf' ? 'unsafe' : mode;
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
    diagnostics: unknown;
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
    if (turn.diagnostics) {
      lines.push(`    diagnostics: ${JSON.stringify(turn.diagnostics, null, 2)}`);
    }
  }

  if (failedTurns.length === 0) {
    lines.push('  - none');
  }

  return lines;
}

function buildInterpreter(mode: InterpreterMode, scenarios: readonly BenchmarkScenario[]) {
  switch (mode) {
    case 'advanced':
      return new AdvancedInterpreter(requireConfiguredModel('advanced'));
    case 'baseline':
      return new BaselineInterpreter(requireConfiguredModel('baseline'));
    case 'perfect':
      return new PerfectFixtureInterpreter(scenarios);
    case 'wrong':
      return new IntentionallyWrongInterpreter(scenarios);
    case 'unsafe':
      return new UnsafeMutationInterpreter(scenarios);
    default:
      throw new Error(`Unsupported interpreter mode: ${mode}`);
  }
}

function requireConfiguredModel(mode: 'baseline' | 'advanced') {
  const model = createConfiguredStructuredActionModel();
  if (!model) {
    throw new Error(
      `Missing OPENAI_API_KEY. Configure a real provider before running TALLI_INTERPRETER_MODE=${mode}.`,
    );
  }

  return model;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function writeTrajectoryArtifact(
  evaluation: Awaited<ReturnType<typeof evaluateBenchmark>>,
  mode: string,
) {
  const directory = process.env.TALLI_TRAJECTORY_DIR?.trim();
  if (!directory) {
    return;
  }

  await mkdir(directory, { recursive: true });
  const fileName = `trajectory-${sanitizeFileName(mode)}-${sanitizeFileName(new Date().toISOString())}.json`;
  const filePath = join(directory, fileName);
  const artifact = {
    generatedAt: new Date().toISOString(),
    mode,
    referenceNow: evaluation.referenceNow,
    timezone: evaluation.timezone,
    scenarioCount: evaluation.scenarioCount,
    turnCount: evaluation.turnCount,
    lsa: evaluation.lsa,
    actionAccuracy: evaluation.actionAccuracy,
    abstentionRequiredTurnCount: evaluation.abstentionRequiredTurnCount,
    unsafeMutationCount: evaluation.unsafeMutationCount,
    umr: evaluation.umr,
    scenarios: evaluation.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      title: scenario.title,
      purpose: scenario.purpose,
      lsa: scenario.lsa,
      actionAccuracy: scenario.actionAccuracy,
      abstentionRequiredTurnCount: scenario.abstentionRequiredTurnCount,
      unsafeMutationCount: scenario.unsafeMutationCount,
      turns: scenario.turns.map((turn) => ({
        turnId: turn.turnId,
        inputText: turn.inputText,
        language: turn.language,
        expectMutation: turn.expectMutation,
        mutationOccurred: turn.mutationOccurred,
        clarificationOccurred: turn.clarificationOccurred,
        stateMatch: turn.stateMatch,
        actionMatch: turn.actionMatch,
        unsafeMutation: turn.unsafeMutation,
        expectedAction: turn.expectedAction,
        actualAction: turn.actualAction,
        expectedCanonicalAction: turn.expectedCanonicalAction,
        actualCanonicalAction: turn.actualCanonicalAction,
        expectedSnapshot: turn.expectedCanonicalSnapshot,
        actualSnapshot: turn.actualCanonicalSnapshot,
        diagnostics: turn.diagnostics,
      })),
    })),
  };

  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function main() {
  const mode = readInterpreterMode();
  const outputFormat = readOutputFormat();
  const interpreter = buildInterpreter(mode, seedScenarios);
  const evaluation = await evaluateBenchmark(seedScenarios, interpreter, mode);
  await writeTrajectoryArtifact(evaluation, mode);

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
