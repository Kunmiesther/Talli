import { describe, expect, it, vi } from 'vitest';
import { ledgerActionSchema } from '../src/domain/actions.js';
import {
  applyLedgerAction,
  createIdFactory,
  createLedgerDocument,
  projectLedger,
} from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';
import {
  AdvancedInterpreter,
  BaselineInterpreter,
  type InterpreterInput,
} from '../src/interpreters.js';
import {
  OpenAICompatibleStructuredActionModel,
  type StructuredActionModel,
  type StructuredActionModelRequest,
  type StructuredActionModelResult,
} from '../src/llm/structured-action-model.js';

function createFetchResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => body,
    headers: {
      get: (name: string) => (name === 'x-request-id' ? 'req_test' : null),
    },
  } as unknown as Response;
}

class CapturingModel implements StructuredActionModel {
  readonly provider = 'mock';
  readonly model = 'mock';
  lastRequest: StructuredActionModelRequest | null = null;

  constructor(private readonly result: StructuredActionModelResult) {}

  async generateLedgerAction(request: StructuredActionModelRequest) {
    this.lastRequest = request;
    return this.result;
  }
}

describe('structured action provider', () => {
  it('validates a structured model response against the action schema', async () => {
    const provider = new OpenAICompatibleStructuredActionModel({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: vi.fn(async () =>
        createFetchResponse(
          JSON.stringify({
            id: 'resp_1',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: 'NO_ACTION',
                    reason: 'Nothing to do.',
                    permittedMutation: false,
                    evidence: [],
                    source: { utterance: 'nothing', language: 'en' },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 12,
              total_tokens: 22,
            },
          }),
        ),
      ) as typeof fetch,
    });

    const result = await provider.generateLedgerAction({
      systemInstructions: 'system',
      userInput: 'user',
      context: { clock: { referenceNow: '2026-08-29T09:00:00+01:00', timezone: 'Africa/Lagos' } },
      schemaName: 'LedgerAction',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a successful provider result.');
    }
    expect(result.action).toEqual(
      ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'Nothing to do.',
        permittedMutation: false,
        evidence: [],
        source: { utterance: 'nothing', language: 'en' },
      }),
    );
    expect(result.diagnostics.attempts).toBe(1);
    expect(result.diagnostics.usage?.totalTokens).toBe(22);
  });

  it('rejects malformed model output safely after bounded retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createFetchResponse(
          JSON.stringify({
            id: 'resp_1',
            choices: [{ message: { content: 'not valid json' } }],
          }),
        ),
      )
      .mockResolvedValue(
        createFetchResponse(
          JSON.stringify({
            id: 'resp_2',
            choices: [{ message: { content: 'still not valid json' } }],
          }),
        ),
      );

    const provider = new OpenAICompatibleStructuredActionModel({
      apiKey: 'test-key',
      model: 'test-model',
      maxAttempts: 2,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await provider.generateLedgerAction({
      systemInstructions: 'system',
      userInput: 'user',
      context: { clock: { referenceNow: '2026-08-29T09:00:00+01:00', timezone: 'Africa/Lagos' } },
      schemaName: 'LedgerAction',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected provider failure for malformed output.');
    }
    expect(result.diagnostics.attempts).toBe(2);
    expect(result.diagnostics.parseErrors.length).toBeGreaterThan(0);
    expect(result.diagnostics.rawOutputs.length).toBeGreaterThan(0);
  });
});

describe('llm-backed interpreters', () => {
  it('keeps baseline requests free of ledger history and entity context', async () => {
    const model = new CapturingModel({
      ok: true,
      action: ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'baseline',
        permittedMutation: false,
        evidence: [],
        source: { utterance: 'test', language: 'en' },
      }),
      diagnostics: {
        provider: 'mock',
        model: 'mock',
        baseUrl: 'mock',
        configured: true,
        attempts: 1,
        latencyMs: 1,
        responseFormatUsed: true,
        rawOutputs: ['{}'],
        parseErrors: [],
        requestIds: [],
      },
    });
    const interpreter = new BaselineInterpreter(model);

    const result = await interpreter.interpret({
      text: 'Amina took 35k goods today.',
      language: 'en',
      benchmark: {
        scenarioId: 'simple-new-credit',
        turnId: 'turn-1',
        referenceNow: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
      },
    });

    expect(result.type).toBe('NO_ACTION');
    expect(model.lastRequest).toBeDefined();
    expect(model.lastRequest?.context).toEqual({
      clock: {
        referenceNow: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
      },
      currentUtterance: 'Amina took 35k goods today.',
      language: 'en',
    });
  });

  it('includes compact ledger facts for advanced interpretation', async () => {
    let document = createLedgerDocument('advanced-context');
    document = applyLedgerAction(
      document,
      ledgerActionSchema.parse({
        type: 'CREATE_OBLIGATION',
        customer: { kind: 'new', name: 'Mama Tobi', aliases: ['Tobi'] },
        amountMinor: nairaToMinorUnits(50_000),
        permittedMutation: true,
        evidence: ['Mama Tobi took 50k goods yesterday.'],
        source: { utterance: 'Mama Tobi took 50k goods yesterday.', language: 'en' },
      }),
      {
        now: new Date('2026-08-28T12:00:00.000Z'),
        actor: 'system',
        idFactory: createIdFactory('ctx'),
      },
    ).document;
    const snapshot = projectLedger(document);
    const model = new CapturingModel({
      ok: true,
      action: ledgerActionSchema.parse({
        type: 'NO_ACTION',
        reason: 'advanced',
        permittedMutation: false,
        evidence: [],
        source: { utterance: 'test', language: 'en' },
      }),
      diagnostics: {
        provider: 'mock',
        model: 'mock',
        baseUrl: 'mock',
        configured: true,
        attempts: 1,
        latencyMs: 1,
        responseFormatUsed: true,
        rawOutputs: ['{}'],
        parseErrors: [],
        requestIds: [],
      },
    });
    const interpreter = new AdvancedInterpreter(model);

    await interpreter.interpret({
      text: 'Mama Tobi don bring 20k from that money.',
      language: 'pcm',
      benchmark: {
        scenarioId: 'pidgin-multi-turn',
        turnId: 'turn-2',
        referenceNow: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
      },
      snapshot,
      document,
      recentTexts: ['Mama Tobi carry goods of 50k yesterday.'],
    });

    expect(model.lastRequest).toBeDefined();
    expect(model.lastRequest?.context).toMatchObject({
      currentUtterance: 'Mama Tobi don bring 20k from that money.',
      language: 'pcm',
      customers: [
        expect.objectContaining({
          id: expect.any(String),
          displayName: 'Mama Tobi',
          aliases: ['Tobi'],
          openObligationIds: [expect.any(String)],
        }),
      ],
      obligations: [
        expect.objectContaining({
          customerName: 'Mama Tobi',
          outstandingMinor: nairaToMinorUnits(50_000),
        }),
      ],
    });
  });

  it('returns a safe clarification when provider output cannot be parsed', async () => {
    const provider = new OpenAICompatibleStructuredActionModel({
      apiKey: 'test-key',
      model: 'test-model',
      maxAttempts: 1,
      fetchImpl: (async () =>
        createFetchResponse(
          JSON.stringify({
            id: 'resp_1',
            choices: [{ message: { content: 'not json at all' } }],
          }),
        )) as typeof fetch,
    });

    const baseline = new BaselineInterpreter(provider);
    const result = await baseline.interpret({
      text: 'Amina paid 10k.',
      language: 'en',
      benchmark: {
        scenarioId: 'partial-payment',
        turnId: 'turn-2',
        referenceNow: '2026-08-29T09:00:00+01:00',
        timezone: 'Africa/Lagos',
      },
    } satisfies InterpreterInput);

    expect(result.type).toBe('REQUEST_CLARIFICATION');
    expect(baseline.lastDiagnostics?.providerFailure?.reason).toBeDefined();
    expect(baseline.lastDiagnostics?.provider?.parseErrors.length).toBeGreaterThan(0);
  });
});
