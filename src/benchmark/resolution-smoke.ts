import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';
import { AdvancedInterpreter } from '../interpreters.js';
import type { StructuredActionModel } from '../llm/structured-action-model.js';
import { createConfiguredStructuredActionModel } from '../llm/structured-action-model.js';
import { BENCHMARK_CLOCK } from './scenarios.js';

interface SmokeCaseArtifact {
  name: string;
  utterance: string;
  language: 'en' | 'pcm';
  benchmark: {
    scenarioId: string;
    turnId: string;
    referenceNow: string;
    timezone: string;
  };
  candidatePackage: unknown;
  modelIntent: unknown;
  compiledAction: unknown;
  providerDiagnostics: unknown;
  compilerDiagnostics: unknown;
  beforeSnapshot: LedgerSnapshot;
  afterSnapshot: LedgerSnapshot;
  schemaValid: boolean;
  providerFailure: boolean;
  rateLimitFailure: boolean;
  mutationOccurred: boolean;
  clarificationOccurred: boolean;
  semanticCorrect: boolean;
  failureModes: string[];
}

interface SmokeRunArtifact {
  generatedAt: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  successGate: {
    schemaValidCount: number;
    semanticCorrectCount: number;
    duplicateAmbiguitySafe: boolean;
    passed: boolean;
  };
  cases: SmokeCaseArtifact[];
}

interface SeedStep {
  action: LedgerAction;
  now: string;
  turnId: string;
  sourceText: string;
}

interface SeedState {
  document: LedgerDocument;
  snapshot: LedgerSnapshot;
}

function smokeOutputPath(): string {
  const override = process.env.TALLI_SMOKE_OUTPUT?.trim();
  if (override) {
    return override;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join('artifacts', 'experiments', `resolution-smoke-${stamp}.json`);
}

function trajectoryOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join('artifacts', 'trajectories', `trajectory-resolution-smoke-${stamp}.json`);
}

function seedState(steps: SeedStep[]): SeedState {
  let document = createLedgerDocument('resolution-smoke');

  for (const step of steps) {
    const result = applyLedgerAction(document, step.action, {
      now: new Date(step.now),
      actor: 'system',
      turnId: step.turnId,
      sourceText: step.sourceText,
      idFactory: createIdFactory(`resolution-smoke-${step.turnId}`),
    });
    document = result.document;
  }

  return {
    document,
    snapshot: projectLedger(document),
  };
}

function createObligationSeed(input: {
  customerName: string;
  aliases?: string[];
  amountMinor: number;
  turnId: string;
  sourceText: string;
  now: string;
  dueAt?: string | null;
}): SeedStep {
  return {
    action: ledgerActionSchema.parse({
      type: 'CREATE_OBLIGATION',
      customer: {
        kind: 'new',
        name: input.customerName,
        aliases: input.aliases ?? [],
      },
      amountMinor: input.amountMinor,
      dueAt: input.dueAt ?? null,
      permittedMutation: true,
      evidence: [input.sourceText],
      source: { utterance: input.sourceText, language: 'en' },
    }),
    now: input.now,
    turnId: input.turnId,
    sourceText: input.sourceText,
  };
}

function applyResult(
  document: LedgerDocument,
  action: LedgerAction,
  turnId: string,
  sourceText: string,
): LedgerDocument {
  if (
    !action.permittedMutation ||
    action.type === 'REQUEST_CLARIFICATION' ||
    action.type === 'NO_ACTION'
  ) {
    return document;
  }

  return applyLedgerAction(document, action, {
    now: new Date(BENCHMARK_CLOCK.referenceNow),
    actor: 'system',
    turnId,
    sourceText,
    idFactory: createIdFactory(`resolution-smoke-${turnId}`),
  }).document;
}

function candidateIdsFromPackage(
  package_: SmokeCaseArtifact['candidatePackage'] | null | undefined,
  key: 'customerCandidates' | 'obligationCandidates',
): string[] {
  if (!package_ || typeof package_ !== 'object') {
    return [];
  }

  const candidates = (package_ as Record<string, unknown>)[key];
  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object') {
        return null;
      }
      const record = candidate as Record<string, unknown>;
      const value = key === 'customerCandidates' ? record.customerId : record.obligationId;
      return typeof value === 'string' ? value : null;
    })
    .filter((value): value is string => typeof value === 'string');
}

function actionType(action: unknown): string {
  if (!action || typeof action !== 'object') {
    return 'unknown';
  }

  const value = (action as Record<string, unknown>).type;
  return typeof value === 'string' ? value : 'unknown';
}

function isRequestClarification(action: unknown): boolean {
  return actionType(action) === 'REQUEST_CLARIFICATION';
}

function isRecordPayment(action: unknown): boolean {
  return actionType(action) === 'RECORD_PAYMENT';
}

function isCorrectObligation(action: unknown): boolean {
  return actionType(action) === 'CORRECT_OBLIGATION';
}

function actionObligationId(action: unknown): string | null {
  if (!action || typeof action !== 'object') {
    return null;
  }

  const obligation = (action as Record<string, unknown>).obligation;
  if (!obligation || typeof obligation !== 'object') {
    return null;
  }

  const record = obligation as Record<string, unknown>;
  if (typeof record.obligationId === 'string') {
    return record.obligationId;
  }

  return null;
}

function actionCustomerIds(action: unknown): string[] {
  if (!action || typeof action !== 'object') {
    return [];
  }

  const customerIds = (action as Record<string, unknown>).candidateCustomerIds;
  if (!Array.isArray(customerIds)) {
    return [];
  }

  return customerIds.filter((value): value is string => typeof value === 'string');
}

function actionMutationPermitted(action: unknown): boolean {
  return Boolean(
    action && typeof action === 'object' && (action as Record<string, unknown>).permittedMutation,
  );
}

function latestOutstanding(snapshot: LedgerSnapshot, obligationId: string): number | null {
  const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
  return obligation ? obligation.outstandingMinor : null;
}

function buildCaseResult(input: {
  name: string;
  utterance: string;
  language: 'en' | 'pcm';
  benchmark: SmokeCaseArtifact['benchmark'];
  beforeSnapshot: LedgerSnapshot;
  afterSnapshot: LedgerSnapshot;
  interpreterDiagnostics: NonNullable<AdvancedInterpreter['lastDiagnostics']>;
  returnedAction: LedgerAction;
  semanticCorrect: boolean;
  failureModes: string[];
}): SmokeCaseArtifact {
  const diagnostics = input.interpreterDiagnostics;
  const provider = diagnostics.provider;
  const schemaValid = provider ? provider.schemaInvalidResponses === 0 : false;
  const providerFailure = provider ? provider.providerFailures > 0 : false;
  const rateLimitFailure = provider ? provider.rateLimitFailures > 0 : false;
  const mutationOccurred = actionMutationPermitted(input.returnedAction);
  const clarificationOccurred = isRequestClarification(input.returnedAction);

  return {
    name: input.name,
    utterance: input.utterance,
    language: input.language,
    benchmark: input.benchmark,
    candidatePackage: diagnostics.advancedContext,
    modelIntent: diagnostics.modelIntent,
    compiledAction: input.returnedAction,
    providerDiagnostics: diagnostics.provider,
    compilerDiagnostics: diagnostics.compiler,
    beforeSnapshot: input.beforeSnapshot,
    afterSnapshot: input.afterSnapshot,
    schemaValid,
    providerFailure,
    rateLimitFailure,
    mutationOccurred,
    clarificationOccurred,
    semanticCorrect: input.semanticCorrect,
    failureModes: input.failureModes,
  };
}

async function runCase(input: {
  name: string;
  model: StructuredActionModel;
  state: SeedState;
  utterance: string;
  language: 'en' | 'pcm';
  benchmark: SmokeCaseArtifact['benchmark'];
  recentTurns: Array<{ turnId: string; text: string }>;
  semanticCheck: (result: {
    action: LedgerAction;
    beforeSnapshot: LedgerSnapshot;
    afterSnapshot: LedgerSnapshot;
    diagnostics: NonNullable<AdvancedInterpreter['lastDiagnostics']>;
  }) => { semanticCorrect: boolean; failureModes: string[] };
}) {
  const interpreter = new AdvancedInterpreter(input.model);
  const beforeDocument = input.state.document;
  const beforeSnapshot = input.state.snapshot;
  const action = await interpreter.interpret({
    text: input.utterance,
    language: input.language,
    benchmark: input.benchmark,
    snapshot: beforeSnapshot,
    document: beforeDocument,
    recentTurns: input.recentTurns,
  });
  const diagnostics = interpreter.lastDiagnostics;
  if (!diagnostics) {
    throw new Error(`Missing diagnostics for smoke case ${input.name}.`);
  }

  const afterDocument = applyResult(
    beforeDocument,
    action,
    input.benchmark.turnId,
    input.utterance,
  );
  const afterSnapshot = projectLedger(afterDocument);
  const semantic = input.semanticCheck({
    action,
    beforeSnapshot,
    afterSnapshot,
    diagnostics,
  });

  return buildCaseResult({
    name: input.name,
    utterance: input.utterance,
    language: input.language,
    benchmark: input.benchmark,
    beforeSnapshot,
    afterSnapshot,
    interpreterDiagnostics: diagnostics,
    returnedAction: action,
    semanticCorrect: semantic.semanticCorrect,
    failureModes: semantic.failureModes,
  });
}

function caseSuccessSummary(result: SmokeCaseArtifact): string {
  const candidateCustomers = candidateIdsFromPackage(result.candidatePackage, 'customerCandidates');
  const candidateObligations = candidateIdsFromPackage(
    result.candidatePackage,
    'obligationCandidates',
  );
  return [
    `schemaValid=${result.schemaValid}`,
    `semanticCorrect=${result.semanticCorrect}`,
    `clarification=${result.clarificationOccurred}`,
    `mutation=${result.mutationOccurred}`,
    `candidateCustomers=${candidateCustomers.length}`,
    `candidateObligations=${candidateObligations.length}`,
  ].join(', ');
}

async function main() {
  const generatedAt = new Date().toISOString();
  const model = createConfiguredStructuredActionModel();
  if (!model) {
    throw new Error(
      'Missing OPENAI_API_KEY. Configure the provider before running the smoke suite.',
    );
  }

  const results: SmokeCaseArtifact[] = [];

  const case1 = await runCase({
    name: 'existing-customer-partial-payment',
    model,
    state: seedState([
      createObligationSeed({
        customerName: 'Amina',
        amountMinor: nairaToMinorUnits(60_000),
        turnId: 'seed-1',
        sourceText: 'Amina took 60k goods.',
        now: '2026-08-28T08:00:00.000Z',
      }),
    ]),
    utterance: 'Amina dropped 15k this morning.',
    language: 'en',
    benchmark: {
      scenarioId: 'smoke-existing-partial-payment',
      turnId: 'turn-1',
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
    },
    recentTurns: [{ turnId: 'seed-1', text: 'Amina took 60k goods.' }],
    semanticCheck: ({ action, beforeSnapshot, afterSnapshot }) => {
      const targetId = beforeSnapshot.obligations[0]?.id ?? null;
      const beforeOutstanding = targetId ? latestOutstanding(beforeSnapshot, targetId) : null;
      const afterOutstanding = targetId ? latestOutstanding(afterSnapshot, targetId) : null;
      const semanticCorrect =
        isRecordPayment(action) &&
        action.permittedMutation === true &&
        actionObligationId(action) === targetId &&
        beforeOutstanding === nairaToMinorUnits(60_000) &&
        afterOutstanding === nairaToMinorUnits(45_000);

      return {
        semanticCorrect,
        failureModes: semanticCorrect ? [] : ['payment/settlement interpretation'],
      };
    },
  });
  results.push(case1);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const case2 = await runCase({
    name: 'natural-reference-first-obligation',
    model,
    state: seedState([
      createObligationSeed({
        customerName: 'Binta',
        amountMinor: nairaToMinorUnits(20_000),
        turnId: 'seed-1',
        sourceText: 'Binta took 20k goods.',
        now: '2026-08-21T08:00:00.000Z',
      }),
      createObligationSeed({
        customerName: 'Binta',
        amountMinor: nairaToMinorUnits(35_000),
        turnId: 'seed-2',
        sourceText: 'Binta took 35k goods later in the week.',
        now: '2026-08-25T08:00:00.000Z',
      }),
    ]),
    utterance: 'Binta paid 8k on the first one.',
    language: 'en',
    benchmark: {
      scenarioId: 'smoke-natural-reference',
      turnId: 'turn-2',
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
    },
    recentTurns: [{ turnId: 'seed-2', text: 'Binta took 35k goods later in the week.' }],
    semanticCheck: ({ action, beforeSnapshot, afterSnapshot }) => {
      const targetId = beforeSnapshot.obligations[0]?.id ?? null;
      const beforeOutstanding = targetId ? latestOutstanding(beforeSnapshot, targetId) : null;
      const afterOutstanding = targetId ? latestOutstanding(afterSnapshot, targetId) : null;
      const semanticCorrect =
        isRecordPayment(action) &&
        action.permittedMutation === true &&
        actionObligationId(action) === targetId &&
        beforeOutstanding === nairaToMinorUnits(20_000) &&
        afterOutstanding === nairaToMinorUnits(12_000);

      return {
        semanticCorrect,
        failureModes: semanticCorrect ? [] : ['reference resolution'],
      };
    },
  });
  results.push(case2);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const case3 = await runCase({
    name: 'correction-targeting',
    model,
    state: (() => {
      const initial = seedState([
        createObligationSeed({
          customerName: 'Kemi',
          amountMinor: nairaToMinorUnits(30_000),
          turnId: 'seed-1',
          sourceText: 'Kemi took 30k goods.',
          now: '2026-08-20T08:00:00.000Z',
        }),
      ]);
      const customerId = initial.snapshot.customers[0]?.id ?? '';
      const obligationId = initial.snapshot.obligations[0]?.id ?? '';
      const payment = ledgerActionSchema.parse({
        type: 'RECORD_PAYMENT',
        customer: { kind: 'id', customerId },
        obligation: { kind: 'id', obligationId },
        amountMinor: nairaToMinorUnits(10_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Kemi dropped 10k before the correction.'],
        source: { utterance: 'Kemi dropped 10k before the correction.', language: 'en' },
      });
      const document = applyLedgerAction(initial.document, payment, {
        now: new Date('2026-08-26T08:00:00.000Z'),
        actor: 'system',
        turnId: 'seed-2',
        sourceText: 'Kemi dropped 10k before the correction.',
        idFactory: createIdFactory('resolution-smoke-seed-2'),
      }).document;
      return {
        document,
        snapshot: projectLedger(document),
      };
    })(),
    utterance: 'Actually, that Kemi debt was 45k, not 30k.',
    language: 'en',
    benchmark: {
      scenarioId: 'smoke-correction',
      turnId: 'turn-3',
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
    },
    recentTurns: [
      { turnId: 'seed-1', text: 'Kemi took 30k goods.' },
      { turnId: 'seed-2', text: 'Kemi dropped 10k before the correction.' },
    ],
    semanticCheck: ({ action, beforeSnapshot, afterSnapshot }) => {
      const targetId = beforeSnapshot.obligations[0]?.id ?? null;
      const afterOutstanding = targetId ? latestOutstanding(afterSnapshot, targetId) : null;
      const semanticCorrect =
        isCorrectObligation(action) &&
        action.permittedMutation === true &&
        actionObligationId(action) === targetId &&
        afterOutstanding === nairaToMinorUnits(35_000);

      return {
        semanticCorrect,
        failureModes: semanticCorrect ? [] : ['correction handling'],
      };
    },
  });
  results.push(case3);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const case4 = await runCase({
    name: 'duplicate-name-ambiguity',
    model,
    state: seedState([
      createObligationSeed({
        customerName: 'Musa',
        amountMinor: nairaToMinorUnits(20_000),
        turnId: 'seed-1',
        sourceText: 'First Musa took 20k goods.',
        now: '2026-08-22T08:00:00.000Z',
      }),
      createObligationSeed({
        customerName: 'Musa',
        amountMinor: nairaToMinorUnits(40_000),
        turnId: 'seed-2',
        sourceText: 'Second Musa took 40k goods.',
        now: '2026-08-23T08:00:00.000Z',
      }),
    ]),
    utterance: 'Musa just dropped 10k.',
    language: 'en',
    benchmark: {
      scenarioId: 'smoke-ambiguity',
      turnId: 'turn-4',
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
    },
    recentTurns: [{ turnId: 'seed-2', text: 'Second Musa took 40k goods.' }],
    semanticCheck: ({ action, beforeSnapshot, afterSnapshot }) => {
      const candidateIds = actionCustomerIds(action);
      const expectedCustomerIds = beforeSnapshot.customers.map((customer) => customer.id);
      const semanticCorrect =
        isRequestClarification(action) &&
        candidateIds.length === 2 &&
        expectedCustomerIds.every((customerId) => candidateIds.includes(customerId)) &&
        JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot);

      return {
        semanticCorrect,
        failureModes: semanticCorrect
          ? []
          : ['customer/entity resolution', 'unnecessary clarification'],
      };
    },
  });
  results.push(case4);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const case5 = await runCase({
    name: 'pidgin-partial-payment',
    model,
    state: seedState([
      createObligationSeed({
        customerName: 'Mama Tobi',
        aliases: ['Tobi'],
        amountMinor: nairaToMinorUnits(50_000),
        turnId: 'seed-1',
        sourceText: 'Mama Tobi carry 50k goods.',
        now: '2026-08-28T08:00:00.000Z',
      }),
    ]),
    utterance: 'Mama Tobi don drop 20k from the debt wey she get.',
    language: 'pcm',
    benchmark: {
      scenarioId: 'smoke-pidgin',
      turnId: 'turn-5',
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
    },
    recentTurns: [{ turnId: 'seed-1', text: 'Mama Tobi carry 50k goods.' }],
    semanticCheck: ({ action, beforeSnapshot, afterSnapshot }) => {
      const targetId = beforeSnapshot.obligations[0]?.id ?? null;
      const beforeOutstanding = targetId ? latestOutstanding(beforeSnapshot, targetId) : null;
      const afterOutstanding = targetId ? latestOutstanding(afterSnapshot, targetId) : null;
      const semanticCorrect =
        isRecordPayment(action) &&
        action.permittedMutation === true &&
        actionObligationId(action) === targetId &&
        beforeOutstanding === nairaToMinorUnits(50_000) &&
        afterOutstanding === nairaToMinorUnits(30_000);

      return {
        semanticCorrect,
        failureModes: semanticCorrect ? [] : ['Nigerian Pidgin interpretation'],
      };
    },
  });
  results.push(case5);

  const schemaValidCount = results.filter((result) => result.schemaValid).length;
  const semanticCorrectCount = results.filter((result) => result.semanticCorrect).length;
  const duplicateAmbiguitySafe = case4.semanticCorrect;
  const passed =
    schemaValidCount === results.length && duplicateAmbiguitySafe && semanticCorrectCount >= 4;

  const artifact: SmokeRunArtifact = {
    generatedAt,
    provider: model.provider,
    model: model.model,
    baseUrl: process.env.OPENAI_BASE_URL?.trim() ?? null,
    successGate: {
      schemaValidCount,
      semanticCorrectCount,
      duplicateAmbiguitySafe,
      passed,
    },
    cases: results,
  };

  await mkdir('artifacts/experiments', { recursive: true });
  await writeFile(smokeOutputPath(), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  await mkdir('artifacts/trajectories', { recursive: true });
  await writeFile(
    trajectoryOutputPath(),
    `${JSON.stringify(
      {
        generatedAt,
        provider: model.provider,
        model: model.model,
        successGate: artifact.successGate,
        cases: results.map((result) => ({
          name: result.name,
          utterance: result.utterance,
          language: result.language,
          candidatePackage: result.candidatePackage,
          modelIntent: result.modelIntent,
          compiledAction: result.compiledAction,
          providerDiagnostics: result.providerDiagnostics,
          compilerDiagnostics: result.compilerDiagnostics,
          mutationOccurred: result.mutationOccurred,
          clarificationOccurred: result.clarificationOccurred,
          semanticCorrect: result.semanticCorrect,
          failureModes: result.failureModes,
          beforeSnapshot: result.beforeSnapshot,
          afterSnapshot: result.afterSnapshot,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  for (const result of results) {
    console.log(`${result.name}: ${caseSuccessSummary(result)}`);
  }

  if (!passed) {
    throw new Error('Resolution smoke suite failed the success gate.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
