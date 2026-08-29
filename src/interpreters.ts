import { type LedgerAction, ledgerActionSchema } from './domain/actions.js';
import type { LedgerSnapshot } from './domain/ledger.js';
import {
  createLedgerDocument,
  normalizeLedgerName,
  projectLedger,
  resolveCustomerCandidates,
  selectObligationFromRef,
} from './domain/ledger.js';
import { nairaToMinorUnits } from './domain/money.js';

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
  recentTexts: string[];
}

export interface ActionInterpreter {
  kind: 'baseline' | 'advanced';
  interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction>;
}

export function detectLanguage(text: string): 'en' | 'pcm' | 'mixed' {
  const lower = text.toLowerCase();
  const pidginMarkers = [
    'dey',
    'na',
    'wahala',
    'don',
    'yesterday',
    'shey',
    'wetin',
    'for',
    'no be',
  ];
  const hits = pidginMarkers.filter((marker) => lower.includes(marker)).length;
  if (hits >= 2) {
    return 'pcm';
  }
  if (hits === 1) {
    return 'mixed';
  }
  return 'en';
}

function parseMoneyExpression(text: string): number | undefined {
  const normalized = text.toLowerCase().replace(/₦/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ');
  const matches = [
    /(\d+(?:\.\d+)?)\s*(k|thousand|grand)\b/,
    /(?:₦|\bnaira\b)\s*(\d+(?:\.\d+)?)\b/,
    /\b(\d{1,3}(?: \d{3})+)\b/,
    /\b(\d+)\b/,
  ];

  for (const pattern of matches) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const rawValue = match[1];
    if (!rawValue) {
      continue;
    }

    const value = Number(rawValue.replace(/\s+/g, ''));
    if (!Number.isFinite(value)) {
      continue;
    }

    const unit = match[2];
    if (unit === 'k' || unit === 'thousand' || unit === 'grand') {
      return nairaToMinorUnits(Math.trunc(value * 1000));
    }

    if (normalized.includes('kobo')) {
      return Math.trunc(value);
    }

    if (normalized.includes('naira') || normalized.includes('₦')) {
      return nairaToMinorUnits(Math.trunc(value));
    }

    if (value <= 1000) {
      return nairaToMinorUnits(Math.trunc(value * 1000));
    }

    return nairaToMinorUnits(Math.trunc(value));
  }

  return undefined;
}

function extractName(text: string): string | undefined {
  const cleaned = text.trim();
  const patterns = [
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
    /(?:for|from|to|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const knownWords = cleaned.split(/\s+/).filter((token) => /^[A-Z][a-z]+$/.test(token));
  return knownWords.length > 0 ? knownWords.join(' ') : undefined;
}

function textLooksLikePayment(text: string): boolean {
  return /\b(paid|brought|brought back|returned|gave|gave me|settled|balance)\b/i.test(text);
}

function textLooksLikeCorrection(text: string): boolean {
  return /\b(not|rather|actually|correction|change|mistake|wasn't|it was)\b/i.test(text);
}

function textLooksLikeDebt(text: string): boolean {
  return /\b(took|bought|owed|borrowed|collect|collected|goods|credit)\b/i.test(text);
}

function findLatestCustomerName(snapshot: LedgerSnapshot): string | undefined {
  const latest = snapshot.customers.at(-1);
  return latest?.displayName;
}

function buildCreateAction(text: string, name: string, amountMinor: number): LedgerAction {
  return ledgerActionSchema.parse({
    type: 'CREATE_OBLIGATION',
    customer: { kind: 'new', name, aliases: [] },
    amountMinor,
    permittedMutation: true,
    evidence: [text],
    source: { utterance: text, language: detectLanguage(text) },
  });
}

function buildPaymentAction(
  text: string,
  customerName: string | undefined,
  amountMinor: number | undefined,
  snapshot?: LedgerSnapshot,
  recentTexts: string[] = [],
): LedgerAction {
  const base: Record<string, unknown> = {
    type: 'RECORD_PAYMENT',
    permittedMutation: true,
    evidence: [text, ...recentTexts.slice(-2)],
    source: { utterance: text, language: detectLanguage(text) },
    settleRemaining: /\b(balance|remaining|rest|full|everything)\b/i.test(text),
  };

  if (customerName) {
    base.customer = { kind: 'name', name: customerName, allowCreate: false };
  }

  if (amountMinor !== undefined) {
    base.amountMinor = amountMinor;
  }

  if (snapshot && customerName) {
    const customerResolution = resolveCustomerCandidates(snapshot, {
      kind: 'name',
      name: customerName,
      allowCreate: false,
    });
    if (customerResolution.kind === 'resolved') {
      base.customer = { kind: 'id', customerId: customerResolution.customer.id };
      const obligationResolution = selectObligationFromRef(
        snapshot,
        {
          kind: 'latestOpenForCustomer',
          customer: { kind: 'id', customerId: customerResolution.customer.id },
        },
        customerResolution.customer,
      );
      if (obligationResolution.kind === 'resolved') {
        base.obligation = { kind: 'id', obligationId: obligationResolution.obligation.id };
      }
    }
    if (customerResolution.kind === 'ambiguous') {
      base.customer = {
        kind: 'ambiguous',
        candidateCustomerIds: customerResolution.candidateCustomerIds,
        name: customerName,
      };
    }
  }

  return ledgerActionSchema.parse(base);
}

function buildCorrectionAction(
  text: string,
  name: string | undefined,
  amountMinor: number,
  snapshot?: LedgerSnapshot,
  recentTexts: string[] = [],
): LedgerAction {
  const base: Record<string, unknown> = {
    type: 'CORRECT_OBLIGATION',
    permittedMutation: true,
    evidence: [text, ...recentTexts.slice(-2)],
    source: { utterance: text, language: detectLanguage(text) },
    correctedAmountMinor: amountMinor,
  };

  if (snapshot && name) {
    const customerResolution = resolveCustomerCandidates(snapshot, {
      kind: 'name',
      name,
      allowCreate: false,
    });
    if (customerResolution.kind === 'resolved') {
      const obligationResolution = selectObligationFromRef(
        snapshot,
        {
          kind: 'latestOpenForCustomer',
          customer: { kind: 'id', customerId: customerResolution.customer.id },
        },
        customerResolution.customer,
      );
      if (obligationResolution.kind === 'resolved') {
        base.obligation = { kind: 'id', obligationId: obligationResolution.obligation.id };
      }
    } else if (customerResolution.kind === 'ambiguous') {
      base.obligation = {
        kind: 'ambiguous',
        candidateObligationIds: [],
        phrase: name,
      };
    }
  }

  if (!base.obligation) {
    base.obligation = { kind: 'reference', phrase: text };
  }

  return ledgerActionSchema.parse(base);
}

function interpretTextOnly(text: string): LedgerAction {
  const amountMinor = parseMoneyExpression(text);
  const name = extractName(text);

  if (textLooksLikeCorrection(text) && amountMinor !== undefined) {
    return buildCorrectionAction(text, name, amountMinor);
  }

  if (textLooksLikePayment(text) && amountMinor !== undefined) {
    return buildPaymentAction(text, name, amountMinor);
  }

  if (textLooksLikeDebt(text) && amountMinor !== undefined && name) {
    return buildCreateAction(text, name, amountMinor);
  }

  return ledgerActionSchema.parse({
    type: 'NO_ACTION',
    reason: 'Could not infer a safe ledger action from the text.',
    permittedMutation: false,
    evidence: [text],
    source: { utterance: text, language: detectLanguage(text) },
  });
}

function interpretWithContext(input: AdvancedInterpreterInput): LedgerAction {
  const { text, snapshot, recentTexts } = input;
  const amountMinor = parseMoneyExpression(text);
  const explicitName = extractName(text);
  const fallbackName = explicitName ?? findLatestCustomerName(snapshot);

  if (textLooksLikeCorrection(text) && amountMinor !== undefined) {
    return buildCorrectionAction(text, fallbackName, amountMinor, snapshot, recentTexts);
  }

  if (textLooksLikePayment(text)) {
    return buildPaymentAction(text, fallbackName, amountMinor, snapshot, recentTexts);
  }

  if (textLooksLikeDebt(text) && amountMinor !== undefined) {
    const customerName = fallbackName ?? 'Unknown customer';
    return buildCreateAction(text, customerName, amountMinor);
  }

  return ledgerActionSchema.parse({
    type: 'REQUEST_CLARIFICATION',
    question: 'I could not determine a safe action from the text.',
    ambiguityKind: 'other',
    candidateCustomerIds: [],
    candidateObligationIds: [],
    permittedMutation: false,
    evidence: [text],
    source: { utterance: text, language: detectLanguage(text) },
  });
}

export class BaselineInterpreter implements ActionInterpreter {
  kind = 'baseline' as const;

  async interpret(input: InterpreterInput): Promise<LedgerAction> {
    return interpretTextOnly(input.text);
  }
}

export class AdvancedInterpreter implements ActionInterpreter {
  kind = 'advanced' as const;

  async interpret(input: InterpreterInput | AdvancedInterpreterInput): Promise<LedgerAction> {
    if (!('snapshot' in input)) {
      return interpretTextOnly(input.text);
    }
    return interpretWithContext(input);
  }
}

export function createEmptyContextualInput(text: string): AdvancedInterpreterInput {
  return {
    text,
    snapshot: projectLedger(createLedgerDocument()),
    recentTexts: [],
  };
}
