import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';
import { buildAdvancedContextPackage } from '../llm/context.js';
import { compileLedgerIntent } from '../llm/intent-compiler.js';
import { ledgerIntentSchema } from '../llm/intent.js';
import { buildAdvancedRequestEnvelope, buildBaselineRequestEnvelope } from '../llm/prompts.js';
import { createConfiguredStructuredActionModel } from '../llm/structured-action-model.js';
import { BENCHMARK_CLOCK } from './scenarios.js';

interface SmokeCaseResult {
  name: string;
  ok: boolean;
  compiledActionType?: string;
  providerDiagnostics: unknown;
  modelIntent?: unknown;
}

function createStateWithAction(
  action: Parameters<typeof applyLedgerAction>[1],
  turnId: string,
  sourceText: string,
  now: string,
) {
  const document = createLedgerDocument(`smoke-${turnId}`);
  const result = applyLedgerAction(document, action, {
    now: new Date(now),
    actor: 'system',
    turnId,
    sourceText,
    idFactory: createIdFactory(`smoke-${turnId}`),
  });
  return {
    document: result.document,
    snapshot: projectLedger(result.document),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOutputPath(): string {
  return (
    process.env.TALLI_SMOKE_OUTPUT?.trim() ||
    join('artifacts', 'experiments', 'contract-smoke.json')
  );
}

async function runSmoke(): Promise<SmokeCaseResult[]> {
  const model = createConfiguredStructuredActionModel();
  if (!model) {
    throw new Error(
      'Missing OPENAI_API_KEY. Configure the provider before running the smoke suite.',
    );
  }

  const results: SmokeCaseResult[] = [];

  {
    const request = buildBaselineRequestEnvelope({
      utterance: "Amina took 35 thousand naira worth of goods today. She'll pay on Friday.",
      referenceNow: BENCHMARK_CLOCK.referenceNow,
      timezone: BENCHMARK_CLOCK.timezone,
      language: 'en',
    });
    const response = await model.generateStructuredResponse({
      ...request,
      context: { clock: BENCHMARK_CLOCK, currentUtterance: request.userInput, language: 'en' },
      schemaName: 'LedgerIntent',
      contractName: 'LedgerIntent',
      contractVersion: '2026-08-29.intent-v1',
      schema: ledgerIntentSchema,
    });

    if (!response.ok) {
      results.push({
        name: 'english-create',
        ok: false,
        providerDiagnostics: response.diagnostics,
      });
    } else {
      const compiled = compileLedgerIntent({
        intent: response.output,
        utterance: "Amina took 35 thousand naira worth of goods today. She'll pay on Friday.",
        language: 'en',
        clock: BENCHMARK_CLOCK,
        snapshot: projectLedger(createLedgerDocument('smoke-empty')),
        document: createLedgerDocument('smoke-empty'),
      });
      results.push({
        name: 'english-create',
        ok: true,
        compiledActionType: compiled.action.type,
        providerDiagnostics: response.diagnostics,
        modelIntent: response.output,
      });
    }
  }

  await sleep(500);

  {
    const state = createStateWithAction(
      {
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Amina', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Amina took 50k goods.'],
        source: { utterance: 'Amina took 50k goods.', language: 'en' },
      },
      'turn-1',
      'Amina took 50k goods.',
      '2026-08-28T08:00:00.000Z',
    );
    const context = buildAdvancedContextPackage({
      snapshot: state.snapshot,
      document: state.document,
      recentTurns: [{ turnId: 'turn-1', text: 'Amina took 50k goods.' }],
      utterance: 'Amina brought 10k this morning.',
      language: 'en',
      clock: BENCHMARK_CLOCK,
    });
    const request = buildAdvancedRequestEnvelope({
      utterance: 'Amina brought 10k this morning.',
      context,
      language: 'en',
    });
    const response = await model.generateStructuredResponse({
      ...request,
      context,
      schemaName: 'LedgerIntent',
      contractName: 'LedgerIntent',
      contractVersion: '2026-08-29.intent-v1',
      schema: ledgerIntentSchema,
    });

    if (!response.ok) {
      results.push({
        name: 'simple-payment',
        ok: false,
        providerDiagnostics: response.diagnostics,
      });
    } else {
      const compiled = compileLedgerIntent({
        intent: response.output,
        utterance: 'Amina brought 10k this morning.',
        language: 'en',
        clock: BENCHMARK_CLOCK,
        snapshot: state.snapshot,
        document: state.document,
      });
      results.push({
        name: 'simple-payment',
        ok: true,
        compiledActionType: compiled.action.type,
        providerDiagnostics: response.diagnostics,
        modelIntent: response.output,
      });
    }
  }

  await sleep(500);

  {
    const state = createStateWithAction(
      {
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Kemi', aliases: [] },
        amountMinor: nairaToMinorUnits(24_000),
        permittedMutation: true,
        evidence: ['Kemi took 24 thousand worth of goods.'],
        source: { utterance: 'Kemi took 24 thousand worth of goods.', language: 'en' },
      },
      'turn-1',
      'Kemi took 24 thousand worth of goods.',
      '2026-08-28T08:00:00.000Z',
    );
    const paid = applyLedgerAction(
      state.document,
      {
        type: 'RECORD_PAYMENT',
        customer: { kind: 'name', name: 'Kemi', allowCreate: false },
        obligation: {
          kind: 'latestOpenForCustomer',
          customer: { kind: 'id', customerId: state.snapshot.customers[0]?.id ?? '' },
        },
        amountMinor: nairaToMinorUnits(4_000),
        settleRemaining: false,
        permittedMutation: true,
        evidence: ['Kemi brought 4k this morning.'],
        source: { utterance: 'Kemi brought 4k this morning.', language: 'en' },
      },
      {
        now: new Date('2026-08-28T09:00:00.000Z'),
        actor: 'system',
        turnId: 'turn-2',
        sourceText: 'Kemi brought 4k this morning.',
        idFactory: createIdFactory('smoke-kemi'),
      },
    );
    const context = buildAdvancedContextPackage({
      snapshot: projectLedger(paid.document),
      document: paid.document,
      recentTurns: [
        { turnId: 'turn-1', text: 'Kemi took 24 thousand worth of goods.' },
        { turnId: 'turn-2', text: 'Kemi brought 4k this morning.' },
      ],
      utterance: "That Kemi money I told you earlier, it wasn't 24. It was 42 thousand.",
      language: 'en',
      clock: BENCHMARK_CLOCK,
    });
    const request = buildAdvancedRequestEnvelope({
      utterance: "That Kemi money I told you earlier, it wasn't 24. It was 42 thousand.",
      context,
      language: 'en',
    });
    const response = await model.generateStructuredResponse({
      ...request,
      context,
      schemaName: 'LedgerIntent',
      contractName: 'LedgerIntent',
      contractVersion: '2026-08-29.intent-v1',
      schema: ledgerIntentSchema,
    });

    if (!response.ok) {
      results.push({ name: 'correction', ok: false, providerDiagnostics: response.diagnostics });
    } else {
      const compiled = compileLedgerIntent({
        intent: response.output,
        utterance: "That Kemi money I told you earlier, it wasn't 24. It was 42 thousand.",
        language: 'en',
        clock: BENCHMARK_CLOCK,
        snapshot: projectLedger(paid.document),
        document: paid.document,
      });
      results.push({
        name: 'correction',
        ok: true,
        compiledActionType: compiled.action.type,
        providerDiagnostics: response.diagnostics,
        modelIntent: response.output,
      });
    }
  }

  await sleep(500);

  {
    const state = createStateWithAction(
      {
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: [] },
        amountMinor: nairaToMinorUnits(50_000),
        dueAt: '2026-08-30T23:00:00.000Z',
        permittedMutation: true,
        evidence: ['Mama Tobi carry goods of 50k yesterday.'],
        source: { utterance: 'Mama Tobi carry goods of 50k yesterday.', language: 'pcm' },
      },
      'turn-1',
      'Mama Tobi carry goods of 50k yesterday.',
      '2026-08-28T08:00:00.000Z',
    );
    const context = buildAdvancedContextPackage({
      snapshot: state.snapshot,
      document: state.document,
      recentTurns: [{ turnId: 'turn-1', text: 'Mama Tobi carry goods of 50k yesterday.' }],
      utterance: 'Mama Tobi don bring 20k from that money.',
      language: 'pcm',
      clock: BENCHMARK_CLOCK,
    });
    const request = buildAdvancedRequestEnvelope({
      utterance: 'Mama Tobi don bring 20k from that money.',
      context,
      language: 'pcm',
    });
    const response = await model.generateStructuredResponse({
      ...request,
      context,
      schemaName: 'LedgerIntent',
      contractName: 'LedgerIntent',
      contractVersion: '2026-08-29.intent-v1',
      schema: ledgerIntentSchema,
    });

    if (!response.ok) {
      results.push({
        name: 'pidgin-payment',
        ok: false,
        providerDiagnostics: response.diagnostics,
      });
    } else {
      const compiled = compileLedgerIntent({
        intent: response.output,
        utterance: 'Mama Tobi don bring 20k from that money.',
        language: 'pcm',
        clock: BENCHMARK_CLOCK,
        snapshot: state.snapshot,
        document: state.document,
      });
      results.push({
        name: 'pidgin-payment',
        ok: true,
        compiledActionType: compiled.action.type,
        providerDiagnostics: response.diagnostics,
        modelIntent: response.output,
      });
    }
  }

  return results;
}

async function main() {
  const startedAt = new Date().toISOString();
  const results = await runSmoke();
  const outputPath = defaultOutputPath();
  await mkdir('artifacts/experiments', { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: startedAt,
        provider: 'groq',
        model: process.env.OPENAI_MODEL ?? null,
        baseUrl: process.env.OPENAI_BASE_URL ?? null,
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    const status = result.ok ? 'ok' : 'fail';
    console.log(`${result.name}: ${status}`);
  }

  if (failed.length > 0) {
    throw new Error(`Smoke suite failed for ${failed.map((entry) => entry.name).join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
