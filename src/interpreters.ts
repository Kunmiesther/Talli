import { type LedgerAction, ledgerActionSchema } from './domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  createLedgerDocument,
  projectLedger,
} from './domain/ledger.js';
import type { ReferenceClock } from './llm/context.js';
import {
  type AdvancedContextPackage,
  type BaselineContextPackage,
  buildAdvancedContextPackage,
  buildBaselineContextPackage,
} from './llm/context.js';
import { buildAdvancedRequestEnvelope, buildBaselineRequestEnvelope } from './llm/prompts.js';
import type {
  StructuredActionModel,
  StructuredActionModelDiagnostics,
} from './llm/structured-action-model.js';

export interface InterpreterInput {
  text: string;
  language?: 'en' | 'pcm' | 'mixed';
  benchmark?: {
    scenarioId: string;
    turnId: string;
    referenceNow: string;
    timezone: string;
  };
}

export interface AdvancedInterpreterInput extends InterpreterInput {
  snapshot: LedgerSnapshot;
  document: LedgerDocument;
  recentTexts: string[];
}

export interface InterpreterRunDiagnostics {
  mode: 'baseline' | 'advanced';
  promptKind: 'baseline' | 'advanced';
  provider: StructuredActionModelDiagnostics | null;
  clock: ReferenceClock;
  inputText: string;
  language: string;
  baselineContext?: BaselineContextPackage;
  advancedContext?: AdvancedContextPackage;
  providerFailure?: {
    reason: string;
    safeActionType: LedgerAction['type'];
  };
}

export interface ActionInterpreter {
  kind: 'baseline' | 'advanced';
  lastDiagnostics: InterpreterRunDiagnostics | null;
  interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction>;
}

function safeClarificationAction(
  question: string,
  ambiguityKind: 'customer' | 'obligation' | 'amount' | 'correction' | 'other' = 'other',
): LedgerAction {
  return ledgerActionSchema.parse({
    type: 'REQUEST_CLARIFICATION',
    question,
    ambiguityKind,
    candidateCustomerIds: [],
    candidateObligationIds: [],
    permittedMutation: false,
    evidence: [],
    source: undefined,
  });
}

function clockFromInput(input: InterpreterInput): ReferenceClock {
  return {
    referenceNow: input.benchmark?.referenceNow ?? new Date().toISOString(),
    timezone: input.benchmark?.timezone ?? 'UTC',
  };
}

function assertAdvancedInput(
  input: InterpreterInput | AdvancedInterpreterInput,
): asserts input is AdvancedInterpreterInput {
  if (!('snapshot' in input) || !('document' in input)) {
    throw new Error('Advanced interpreter requires snapshot and document context.');
  }
}

function failureAction(reason: string): LedgerAction {
  return safeClarificationAction(reason, 'other');
}

export class BaselineInterpreter implements ActionInterpreter {
  kind = 'baseline' as const;
  lastDiagnostics: InterpreterRunDiagnostics | null = null;

  constructor(private readonly model: StructuredActionModel) {}

  async interpret(input: InterpreterInput): Promise<LedgerAction> {
    const clock = clockFromInput(input);
    const baselineContext = buildBaselineContextPackage({
      utterance: input.text,
      language: input.language ?? 'en',
      clock,
    });
    const request = buildBaselineRequestEnvelope({
      utterance: input.text,
      referenceNow: clock.referenceNow,
      timezone: clock.timezone,
      language: input.language,
    });

    const result = await this.model.generateLedgerAction({
      ...request,
      context: baselineContext,
      schemaName: 'LedgerAction',
    });

    if (!result.ok) {
      this.lastDiagnostics = {
        mode: 'baseline',
        promptKind: 'baseline',
        provider: result.diagnostics,
        clock,
        inputText: input.text,
        language: input.language ?? 'en',
        baselineContext,
        providerFailure: {
          reason: result.diagnostics.failureReason ?? 'Provider failed to return a valid action.',
          safeActionType: 'REQUEST_CLARIFICATION',
        },
      };
      return failureAction(
        'I could not produce a safe ledger action from this single turn. Please clarify.',
      );
    }

    this.lastDiagnostics = {
      mode: 'baseline',
      promptKind: 'baseline',
      provider: result.diagnostics,
      clock,
      inputText: input.text,
      language: input.language ?? 'en',
      baselineContext,
    };
    return result.action;
  }
}

export class AdvancedInterpreter implements ActionInterpreter {
  kind = 'advanced' as const;
  lastDiagnostics: InterpreterRunDiagnostics | null = null;

  constructor(private readonly model: StructuredActionModel) {}

  async interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction> {
    assertAdvancedInput(input);
    const clock = clockFromInput(input);
    const advancedContext = buildAdvancedContextPackage({
      snapshot: input.snapshot,
      document: input.document,
      recentTexts: input.recentTexts,
      utterance: input.text,
      language: input.language ?? 'en',
      clock,
    });
    const request = buildAdvancedRequestEnvelope({
      utterance: input.text,
      context: advancedContext,
      language: input.language,
    });

    const result = await this.model.generateLedgerAction({
      ...request,
      context: advancedContext,
      schemaName: 'LedgerAction',
    });

    if (!result.ok) {
      this.lastDiagnostics = {
        mode: 'advanced',
        promptKind: 'advanced',
        provider: result.diagnostics,
        clock,
        inputText: input.text,
        language: input.language ?? 'en',
        advancedContext,
        providerFailure: {
          reason: result.diagnostics.failureReason ?? 'Provider failed to return a valid action.',
          safeActionType: 'REQUEST_CLARIFICATION',
        },
      };
      return failureAction(
        'I could not produce a safe ledger action from this state-aware turn. Please clarify.',
      );
    }

    this.lastDiagnostics = {
      mode: 'advanced',
      promptKind: 'advanced',
      provider: result.diagnostics,
      clock,
      inputText: input.text,
      language: input.language ?? 'en',
      advancedContext,
    };
    return result.action;
  }
}

export function createEmptyContextualInput(text: string): AdvancedInterpreterInput {
  const document = createLedgerDocument();
  const snapshot = projectLedger(document);
  return {
    text,
    snapshot,
    document,
    recentTexts: [],
  };
}
