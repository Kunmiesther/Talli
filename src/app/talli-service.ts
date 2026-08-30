import { randomUUID } from 'node:crypto';
import { type LedgerAction, ledgerActionSchema } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  applyLedgerAction,
  assertLedgerInvariants,
  projectLedger,
  summarizeSnapshot,
} from '../domain/ledger.js';
import { formatMinorUnits } from '../domain/money.js';
import type { ActionInterpreter } from '../interpreters.js';
import { AdvancedInterpreter, type AdvancedInterpreterInput } from '../interpreters.js';
import { compileLedgerIntent } from '../llm/intent-compiler.js';
import { createConfiguredStructuredActionModel } from '../llm/structured-action-model.js';
import { parseExplicitLedgerIntent } from './explicit-intent.js';
import {
  type ConversationTurnRecord,
  type LoadedSession,
  type PendingClarificationState,
  type SessionState,
  TalliSessionStore,
} from './storage.js';

export interface TalliMessageInput {
  text: string;
  sessionId?: string;
  referenceTime?: string;
  timezone?: string;
  language?: 'en' | 'pcm' | 'mixed';
}

export interface TalliLedgerChange {
  customerId?: string;
  customerName?: string;
  obligationId?: string;
  amountMinor?: number;
  outstandingMinor?: number;
  originalAmountMinor?: number;
  status?: 'open' | 'settled';
}

export interface TalliClarificationResponse {
  question: string;
  candidates: Array<{
    kind: 'customer' | 'obligation';
    id: string;
    displayName: string;
    reason?: string;
  }>;
}

export interface TalliMessageResponse {
  status: 'applied' | 'clarification_required' | 'no_action' | 'error';
  message: string;
  action: {
    type: LedgerAction['type'];
    customerId?: string | null;
    customerName?: string | null;
    obligationId?: string | null;
    amountMinor?: number | null;
    correctedAmountMinor?: number | null;
    settleRemaining?: boolean;
    dueAt?: string | null;
  } | null;
  ledgerChange: TalliLedgerChange | null;
  clarification: TalliClarificationResponse | null;
  turnId: string;
  sessionId: string;
  errorCode: string | null;
  modelAvailable: boolean;
}

export interface TalliServiceOptions {
  interpreter?: ActionInterpreter | null;
  store?: TalliSessionStore;
  defaultSessionId?: string;
}

const SAFE_PROVIDER_FAILURE_MESSAGE =
  "I couldn't interpret that safely just now. Nothing was changed. Please try again.";

function formatMoney(minorUnits: number, currency: string): string {
  return formatMinorUnits(minorUnits, currency);
}

function detectLanguage(text: string): 'en' | 'pcm' | 'mixed' {
  if (/\b(don|wey|na|carry|dey|dem|im|una|fit|oo|eh|sha)\b/i.test(text)) {
    return 'pcm';
  }
  return 'en';
}

function formatWeekdayLabel(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(new Date(date));
}

function formatDateLabel(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(date));
}

function formatDuePhrase(dueAt: string | null | undefined, timezone: string): string | null {
  if (!dueAt) {
    return null;
  }
  const weekday = formatWeekdayLabel(dueAt, timezone);
  const dateLabel = formatDateLabel(dueAt, timezone);
  return `${weekday} (${dateLabel})`;
}

function summarizeAction(action: LedgerAction): TalliMessageResponse['action'] {
  switch (action.type) {
    case 'CREATE_OBLIGATION':
      return {
        type: action.type,
        customerName:
          action.customer.kind === 'new' || action.customer.kind === 'name'
            ? action.customer.name
            : action.customer.kind === 'id'
              ? action.customer.customerId
              : null,
        amountMinor: action.amountMinor,
        dueAt: action.dueAt ?? null,
      };
    case 'RECORD_PAYMENT':
      return {
        type: action.type,
        customerId: action.customer?.kind === 'id' ? action.customer.customerId : null,
        obligationId: action.obligation?.kind === 'id' ? action.obligation.obligationId : null,
        amountMinor: action.amountMinor ?? null,
        settleRemaining: action.settleRemaining,
      };
    case 'SETTLE_OBLIGATION':
      return {
        type: action.type,
        obligationId: action.obligation.kind === 'id' ? action.obligation.obligationId : null,
        amountMinor: action.amountMinor ?? null,
      };
    case 'CORRECT_OBLIGATION':
      return {
        type: action.type,
        obligationId: action.obligation.kind === 'id' ? action.obligation.obligationId : null,
        correctedAmountMinor: action.correctedAmountMinor,
      };
    case 'REQUEST_CLARIFICATION':
      return { type: action.type };
    case 'NO_ACTION':
      return { type: action.type };
    default: {
      const never: never = action;
      return never;
    }
  }
}

function formatClarification(
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  snapshot: LedgerSnapshot,
): TalliClarificationResponse {
  const candidates: TalliClarificationResponse['candidates'] = [];

  for (const customerId of action.candidateCustomerIds) {
    const customer = snapshot.customers.find((entry) => entry.id === customerId);
    if (!customer) {
      continue;
    }
    candidates.push({
      kind: 'customer',
      id: customer.id,
      displayName: customer.displayName,
    });
  }

  for (const obligationId of action.candidateObligationIds) {
    const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
    if (!obligation) {
      continue;
    }
    candidates.push({
      kind: 'obligation',
      id: obligation.id,
      displayName: `${obligation.customerName} ${formatMoney(
        obligation.outstandingMinor,
        snapshot.currency,
      )} remaining`,
    });
  }

  return {
    question: action.question,
    candidates,
  };
}

function toPendingClarification(
  turnId: string,
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  sourceText: string,
): PendingClarificationState {
  return {
    turnId,
    question: action.question,
    ambiguityKind: action.ambiguityKind,
    candidateCustomerIds: [...action.candidateCustomerIds],
    candidateObligationIds: [...action.candidateObligationIds],
    sourceText,
    createdAt: new Date().toISOString(),
  };
}

function classifyProviderFailure(diagnostics: unknown): string {
  const typed = diagnostics as {
    rateLimitFailures?: number;
    schemaInvalidResponses?: number;
    failureReason?: string;
    providerFailures?: number;
    rawOutputs?: string[];
  };

  if ((typed.rateLimitFailures ?? 0) > 0) {
    return 'RATE_LIMITED';
  }

  if ((typed.schemaInvalidResponses ?? 0) > 0) {
    return 'INVALID_MODEL_OUTPUT';
  }

  const failureText = [typed.failureReason, ...(typed.rawOutputs ?? [])].filter(Boolean).join(' ');
  if (/fetch failed|HTTP 000|network|ECONN|ENOTFOUND|timeout/i.test(failureText)) {
    return 'PROVIDER_UNAVAILABLE';
  }

  if ((typed.providerFailures ?? 0) > 0) {
    return 'PROVIDER_ERROR';
  }

  return 'PROVIDER_ERROR';
}

function summarizeCustomerChange(
  snapshot: LedgerSnapshot,
  action: LedgerAction,
  resultSnapshot: LedgerSnapshot,
): TalliLedgerChange | null {
  switch (action.type) {
    case 'CREATE_OBLIGATION': {
      const obligation = resultSnapshot.obligations.at(-1);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: obligation.originalAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'RECORD_PAYMENT': {
      const obligationId = action.obligation?.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: action.amountMinor ?? undefined,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'SETTLE_OBLIGATION': {
      const obligationId = action.obligation.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: obligation.originalAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'CORRECT_OBLIGATION': {
      const obligationId = action.obligation.kind === 'id' ? action.obligation.obligationId : null;
      const obligation = resultSnapshot.obligations.find((entry) => entry.id === obligationId);
      if (!obligation) {
        return null;
      }
      return {
        customerId: obligation.customerId,
        customerName: obligation.customerName,
        obligationId: obligation.id,
        amountMinor: action.correctedAmountMinor,
        outstandingMinor: obligation.outstandingMinor,
        originalAmountMinor: obligation.originalAmountMinor,
        status: obligation.status,
      };
    }
    case 'REQUEST_CLARIFICATION':
    case 'NO_ACTION':
      return null;
    default: {
      const never: never = action;
      void never;
      return null;
    }
  }
}

function clarificationMessage(
  action: Extract<LedgerAction, { type: 'REQUEST_CLARIFICATION' }>,
  snapshot: LedgerSnapshot,
): string {
  const names = [
    ...action.candidateCustomerIds.map((customerId) => {
      const customer = snapshot.customers.find((entry) => entry.id === customerId);
      return customer?.displayName ?? customerId;
    }),
    ...action.candidateObligationIds.map((obligationId) => {
      const obligation = snapshot.obligations.find((entry) => entry.id === obligationId);
      return obligation
        ? `${obligation.customerName} (${formatMoney(
            obligation.outstandingMinor,
            snapshot.currency,
          )} remaining)`
        : obligationId;
    }),
  ].filter(Boolean);

  if (names.length === 0) {
    return action.question;
  }

  return `${action.question} Candidates: ${names.join(', ')}.`;
}

function noActionMessage(action: Extract<LedgerAction, { type: 'NO_ACTION' }>): string {
  return action.reason ?? 'No ledger change was made.';
}

function findResultObligation(
  action: LedgerAction,
  snapshotAfter: LedgerSnapshot,
  result: ReturnType<typeof applyLedgerAction>,
): (typeof snapshotAfter.obligations)[number] | undefined {
  if (result.event && 'obligationId' in result.event) {
    const obligationId = result.event.obligationId;
    return snapshotAfter.obligations.find((entry) => entry.id === obligationId);
  }

  if (action.type === 'CREATE_OBLIGATION') {
    return snapshotAfter.obligations.at(-1);
  }

  return undefined;
}

export class TalliService {
  readonly store: TalliSessionStore;
  readonly interpreter: ActionInterpreter | null;

  constructor(options: TalliServiceOptions = {}) {
    this.store =
      options.store ?? new TalliSessionStore({ defaultSessionId: options.defaultSessionId });
    this.interpreter =
      options.interpreter !== undefined ? options.interpreter : this.createDefaultInterpreter();
  }

  private createDefaultInterpreter(): ActionInterpreter | null {
    const model = createConfiguredStructuredActionModel();
    if (!model) {
      return null;
    }
    return new AdvancedInterpreter(model);
  }

  async loadSession(sessionId?: string): Promise<LoadedSession> {
    return this.store.load(sessionId);
  }

  async getLedger(sessionId?: string): Promise<LedgerSnapshot> {
    const session = await this.store.load(sessionId);
    return projectLedger(session.document);
  }

  async getCustomer(customerId: string, sessionId?: string) {
    const snapshot = await this.getLedger(sessionId);
    const customer = snapshot.customers.find((entry) => entry.id === customerId) ?? null;
    const obligations = snapshot.obligations.filter((entry) => entry.customerId === customerId);
    return { customer, obligations };
  }

  async getCustomerHistory(customerId: string, sessionId?: string) {
    const session = await this.store.load(sessionId);
    const snapshot = projectLedger(session.document);
    return {
      customer: snapshot.customers.find((entry) => entry.id === customerId) ?? null,
      obligations: snapshot.obligations.filter((entry) => entry.customerId === customerId),
      events: session.document.events.filter((event) => {
        if ('customerId' in event) {
          return event.customerId === customerId;
        }
        return false;
      }),
      recentTurns: session.state.recentTurns.filter((turn) => {
        return turn.customerId === customerId || turn.obligationId !== null;
      }),
    };
  }

  async resetDemoLedger(sessionId?: string): Promise<void> {
    await this.store.reset(sessionId);
  }

  async seedDemoLedger(sessionId?: string): Promise<void> {
    const { buildDemoSeed } = await import('./demo-data.js');
    const seed = buildDemoSeed();
    await this.store.seed(seed, sessionId);
  }

  async processMessage(input: TalliMessageInput): Promise<TalliMessageResponse> {
    const sessionId = input.sessionId ?? this.store.defaultSessionId;
    const turnId = randomUUID();
    const referenceTime = input.referenceTime ?? new Date().toISOString();
    const timezone = input.timezone ?? this.store.timezone;
    const language = input.language ?? detectLanguage(input.text);
    const loaded = await this.store.load(sessionId);
    let workingDocument = loaded.document;
    let snapshotBefore = projectLedger(workingDocument);
    const currentTurns = loaded.state.recentTurns.slice(-8).map((turn) => ({
      turnId: turn.turnId,
      text: turn.inputText,
    }));
    const pendingClarification = loaded.state.pendingClarification;

    const directParse = parseExplicitLedgerIntent({
      text: input.text,
      snapshot: snapshotBefore,
    });

    if (
      directParse?.explicitCurrency &&
      workingDocument.currency !== directParse.explicitCurrency
    ) {
      const isEmptyLedger =
        snapshotBefore.customers.length === 0 &&
        snapshotBefore.obligations.length === 0 &&
        workingDocument.events.length === 0;
      if (isEmptyLedger) {
        workingDocument = {
          ...workingDocument,
          currency: directParse.explicitCurrency,
        };
        snapshotBefore = projectLedger(workingDocument);
      } else {
        const question = `This ledger is currently using ${workingDocument.currency}, but your update says ${directParse.explicitCurrency}. Switch the ledger currency first.`;
        const response: TalliMessageResponse = {
          status: 'clarification_required',
          message: question,
          action: ledgerActionSchema.parse({
            type: 'REQUEST_CLARIFICATION',
            question,
            ambiguityKind: 'other',
            candidateCustomerIds: [],
            candidateObligationIds: [],
            permittedMutation: false,
            evidence: [],
          }),
          ledgerChange: null,
          clarification: {
            question,
            candidates: [],
          },
          turnId,
          sessionId,
          errorCode: null,
          modelAvailable: Boolean(this.interpreter),
        };
        await this.recordTurn({
          loaded,
          sessionId,
          turnId,
          input,
          language,
          status: 'clarification_required',
          message: response.message,
          errorCode: response.errorCode,
          actionType: 'REQUEST_CLARIFICATION',
          customerId: null,
          obligationId: null,
          amountMinor: null,
          outstandingMinor: null,
          clarification: {
            question,
            ambiguityKind: 'other',
            candidateCustomerIds: [],
            candidateObligationIds: [],
          },
          pendingClarification: loaded.state.pendingClarification,
        });
        return response;
      }
    }

    if (directParse) {
      const compiled = compileLedgerIntent({
        intent: directParse.intent,
        utterance: input.text,
        language,
        clock: {
          referenceNow: referenceTime,
          timezone,
        },
        snapshot: snapshotBefore,
        document: workingDocument,
      });
      const parsedAction = compiled.action;
      const result = applyLedgerAction(workingDocument, parsedAction, {
        now: new Date(referenceTime),
        actor: 'system',
        turnId,
        sourceText: input.text,
      });
      assertLedgerInvariants(result.snapshot);

      const nextState = this.updateSessionState(loaded.state, {
        turnId,
        input,
        language,
        responseAction: parsedAction,
        result,
        sessionId,
      });

      const appendedEvents = result.document.events.slice(workingDocument.events.length);
      await this.store.appendEvents(loaded.ledgerPath, appendedEvents);
      await this.store.saveState(loaded.statePath, nextState);

      return this.buildResponse({
        sessionId,
        turnId,
        input,
        language,
        action: parsedAction,
        result,
        snapshotBefore,
        snapshotAfter: result.snapshot,
      });
    }

    if (!this.interpreter) {
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode: 'PROVIDER_UNAVAILABLE',
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: null,
      });
      return response;
    }

    const interpreterInput: AdvancedInterpreterInput = {
      text: input.text,
      language,
      benchmark: {
        scenarioId: `runtime-${sessionId}`,
        turnId,
        referenceNow: referenceTime,
        timezone,
      },
      snapshot: snapshotBefore,
      document: workingDocument,
      recentTurns: currentTurns,
      pendingClarification,
    };

    let action: LedgerAction;
    try {
      action = await this.interpreter.interpret(interpreterInput);
    } catch (error) {
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode: 'PROVIDER_UNAVAILABLE',
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: null,
      });
      void error;
      return response;
    }

    const providerDiagnostics = this.interpreter.lastDiagnostics?.provider ?? null;
    const providerFailure = this.interpreter.lastDiagnostics?.providerFailure;
    if (providerFailure || !providerDiagnostics) {
      const errorCode = classifyProviderFailure(providerDiagnostics ?? {});
      const response = this.buildErrorResponse({
        sessionId,
        turnId,
        message: SAFE_PROVIDER_FAILURE_MESSAGE,
        errorCode,
      });
      await this.recordTurn({
        loaded,
        sessionId,
        turnId,
        input,
        language,
        status: 'error',
        message: response.message,
        errorCode: response.errorCode,
        actionType: null,
        customerId: null,
        obligationId: null,
        amountMinor: null,
        outstandingMinor: null,
        clarification: null,
        pendingClarification: loaded.state.pendingClarification,
      });
      return response;
    }

    const parsedAction = ledgerActionSchema.parse(action);
    const result = applyLedgerAction(workingDocument, parsedAction, {
      now: new Date(referenceTime),
      actor: 'system',
      turnId,
      sourceText: input.text,
    });
    assertLedgerInvariants(result.snapshot);

    const nextState = this.updateSessionState(loaded.state, {
      turnId,
      input,
      language,
      responseAction: parsedAction,
      result,
      sessionId,
    });

    const appendedEvents = result.document.events.slice(workingDocument.events.length);
    await this.store.appendEvents(loaded.ledgerPath, appendedEvents);
    await this.store.saveState(loaded.statePath, nextState);

    const response = this.buildResponse({
      sessionId,
      turnId,
      input,
      language,
      action: parsedAction,
      result,
      snapshotBefore,
      snapshotAfter: result.snapshot,
    });

    return response;
  }

  private updateSessionState(
    state: SessionState,
    input: {
      turnId: string;
      input: TalliMessageInput;
      language: 'en' | 'pcm' | 'mixed';
      responseAction: LedgerAction;
      result: ReturnType<typeof applyLedgerAction>;
      sessionId: string;
    },
  ): SessionState {
    const clarification =
      input.responseAction.type === 'REQUEST_CLARIFICATION'
        ? toPendingClarification(input.turnId, input.responseAction, input.input.text)
        : null;

    const turnRecord: ConversationTurnRecord = {
      turnId: input.turnId,
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      inputText: input.input.text,
      language: input.language,
      status:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? 'clarification_required'
          : input.responseAction.type === 'NO_ACTION'
            ? 'no_action'
            : 'applied',
      actionType: input.responseAction.type,
      customerId: this.extractTurnCustomerId(input.result),
      obligationId: this.extractTurnObligationId(input.result),
      amountMinor: this.extractTurnAmountMinor(input.result),
      outstandingMinor: this.extractTurnOutstandingMinor(input.result),
      clarification:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? {
              question: input.responseAction.question,
              ambiguityKind: input.responseAction.ambiguityKind,
              candidateCustomerIds: [...input.responseAction.candidateCustomerIds],
              candidateObligationIds: [...input.responseAction.candidateObligationIds],
            }
          : null,
      message:
        input.responseAction.type === 'REQUEST_CLARIFICATION'
          ? input.responseAction.question
          : input.result.financialMutation
            ? 'Applied'
            : input.responseAction.type === 'NO_ACTION'
              ? (input.responseAction.reason ?? 'No action')
              : 'Applied',
      errorCode: null,
    };

    const recentTurns = [...state.recentTurns, turnRecord].slice(-this.store.turnHistoryLimit);
    return {
      ...state,
      ledgerCurrency: input.result.snapshot.currency,
      updatedAt: new Date().toISOString(),
      recentTurns,
      pendingClarification: clarification,
    };
  }

  private extractTurnCustomerId(result: ReturnType<typeof applyLedgerAction>): string | null {
    if (result.event && 'customerId' in result.event) {
      return result.event.customerId;
    }
    return null;
  }

  private extractTurnObligationId(result: ReturnType<typeof applyLedgerAction>): string | null {
    if (result.event && 'obligationId' in result.event) {
      return result.event.obligationId;
    }
    return null;
  }

  private extractTurnAmountMinor(result: ReturnType<typeof applyLedgerAction>): number | null {
    if (result.event && 'amountMinor' in result.event) {
      return result.event.amountMinor;
    }
    return null;
  }

  private extractTurnOutstandingMinor(result: ReturnType<typeof applyLedgerAction>): number | null {
    if (result.event) {
      if ('outstandingAfterMinor' in result.event) {
        return result.event.outstandingAfterMinor;
      }
      if ('correctedOutstandingMinor' in result.event) {
        return result.event.correctedOutstandingMinor;
      }
    }
    return result.snapshot.obligations.at(-1)?.outstandingMinor ?? null;
  }

  private async recordTurn(input: {
    loaded: LoadedSession;
    sessionId: string;
    turnId: string;
    input: TalliMessageInput;
    language: 'en' | 'pcm' | 'mixed';
    status: ConversationTurnRecord['status'];
    message: string;
    errorCode: string | null;
    actionType: string | null;
    customerId: string | null;
    obligationId: string | null;
    amountMinor: number | null;
    outstandingMinor: number | null;
    clarification: ConversationTurnRecord['clarification'];
    pendingClarification: PendingClarificationState | null;
  }): Promise<void> {
    const nextTurn: ConversationTurnRecord = {
      turnId: input.turnId,
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      inputText: input.input.text,
      language: input.language,
      status: input.status,
      actionType: input.actionType,
      customerId: input.customerId,
      obligationId: input.obligationId,
      amountMinor: input.amountMinor,
      outstandingMinor: input.outstandingMinor,
      clarification: input.clarification,
      message: input.message,
      errorCode: input.errorCode,
    };

    const nextState: SessionState = {
      ...input.loaded.state,
      ledgerCurrency: input.loaded.state.ledgerCurrency ?? input.loaded.document.currency,
      updatedAt: new Date().toISOString(),
      recentTurns: [...input.loaded.state.recentTurns, nextTurn].slice(
        -this.store.turnHistoryLimit,
      ),
      pendingClarification: input.pendingClarification,
    };

    await this.store.saveState(input.loaded.statePath, nextState);
  }

  private buildErrorResponse(input: {
    sessionId: string;
    turnId: string;
    message: string;
    errorCode: string;
  }): TalliMessageResponse {
    return {
      status: 'error',
      message: input.message,
      action: null,
      ledgerChange: null,
      clarification: null,
      turnId: input.turnId,
      sessionId: input.sessionId,
      errorCode: input.errorCode,
      modelAvailable: Boolean(this.interpreter),
    };
  }

  private buildResponse(input: {
    sessionId: string;
    turnId: string;
    input: TalliMessageInput;
    language: 'en' | 'pcm' | 'mixed';
    action: LedgerAction;
    result: ReturnType<typeof applyLedgerAction>;
    snapshotBefore: LedgerSnapshot;
    snapshotAfter: LedgerSnapshot;
  }): TalliMessageResponse {
    const action = input.action;
    const summaryAction = summarizeAction(action);

    switch (action.type) {
      case 'REQUEST_CLARIFICATION': {
        const clarification = formatClarification(action, input.snapshotAfter);
        return {
          status: 'clarification_required',
          message: clarificationMessage(action, input.snapshotAfter),
          action: summaryAction,
          ledgerChange: null,
          clarification,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'NO_ACTION':
        return {
          status: 'no_action',
          message: noActionMessage(action),
          action: summaryAction,
          ledgerChange: null,
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      case 'CREATE_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const duePhrase = formatDuePhrase(action.dueAt ?? null, this.store.timezone);
        const customerName =
          obligation?.customerName ??
          (action.customer.kind === 'new' || action.customer.kind === 'name'
            ? action.customer.name
            : action.customer.kind === 'id'
              ? action.customer.customerId
              : 'that customer');
        const message = duePhrase
          ? `${customerName} now owes ${formatMoney(
              obligation?.originalAmountMinor ?? action.amountMinor,
              input.snapshotAfter.currency,
            )}. Due ${duePhrase}.`
          : `${customerName} now owes ${formatMoney(
              obligation?.originalAmountMinor ?? action.amountMinor,
              input.snapshotAfter.currency,
            )}.`;
        return {
          status: 'applied',
          message,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: obligation.originalAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'RECORD_PAYMENT': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const paidAmount = action.amountMinor ?? 0;
        const remaining = obligation?.outstandingMinor ?? 0;
        const customerName = obligation?.customerName ?? 'That customer';
        const message =
          remaining === 0
            ? `Recorded ${formatMoney(paidAmount, input.snapshotAfter.currency)} from ${customerName}.`
            : `Recorded ${formatMoney(
                paidAmount,
                input.snapshotAfter.currency,
              )} from ${customerName}. ${formatMoney(
                remaining,
                input.snapshotAfter.currency,
              )} remains.`;
        return {
          status: 'applied',
          message,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: paidAmount,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'SETTLE_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const customerName = obligation?.customerName ?? 'That customer';
        return {
          status: 'applied',
          message: `${customerName}'s debt is fully settled.`,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: obligation.originalAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      case 'CORRECT_OBLIGATION': {
        const obligation = findResultObligation(action, input.snapshotAfter, input.result);
        const before = input.snapshotBefore.obligations.find((entry) => {
          if (input.result.event && 'obligationId' in input.result.event) {
            return entry.id === input.result.event.obligationId;
          }
          if (action.obligation.kind === 'id') {
            return entry.id === action.obligation.obligationId;
          }
          return false;
        });
        const customerName = obligation?.customerName ?? before?.customerName ?? 'That customer';
        const previous = before?.originalAmountMinor ?? action.correctedAmountMinor;
        const remaining = obligation?.outstandingMinor ?? 0;
        return {
          status: 'applied',
          message: `Updated ${customerName}'s original debt from ${formatMoney(
            previous,
            input.snapshotAfter.currency,
          )} to ${formatMoney(
            action.correctedAmountMinor,
            input.snapshotAfter.currency,
          )}. ${formatMoney(remaining, input.snapshotAfter.currency)} remains.`,
          action: summaryAction,
          ledgerChange: obligation
            ? {
                customerId: obligation.customerId,
                customerName: obligation.customerName,
                obligationId: obligation.id,
                amountMinor: action.correctedAmountMinor,
                outstandingMinor: obligation.outstandingMinor,
                originalAmountMinor: obligation.originalAmountMinor,
                status: obligation.status,
              }
            : summarizeCustomerChange(input.snapshotBefore, action, input.snapshotAfter),
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
      default: {
        const never: never = action;
        void never;
        return {
          status: 'no_action',
          message: 'No ledger change was made.',
          action: summaryAction,
          ledgerChange: null,
          clarification: null,
          turnId: input.turnId,
          sessionId: input.sessionId,
          errorCode: null,
          modelAvailable: true,
        };
      }
    }
  }
}

export function createTalliService(options: TalliServiceOptions = {}): TalliService {
  return new TalliService(options);
}

export function summarizeLedger(snapshot: LedgerSnapshot): string {
  return summarizeSnapshot(snapshot);
}
