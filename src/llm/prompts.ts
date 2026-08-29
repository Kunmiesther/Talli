import { formatNgn } from '../domain/money.js';
import type { AdvancedContextPackage, BaselineContextPackage } from './context.js';

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildBaselineSystemPrompt(): string {
  return [
    'You are Talli Baseline, a single-turn structured ledger parser.',
    'Convert the latest user utterance into exactly one JSON object that matches the LedgerAction schema.',
    'You do not have access to ledger history, entity lists, or recent conversation context.',
    'Use only the utterance and the fixed reference clock included in the user payload.',
    'If the utterance is ambiguous, unsafe, or missing a required target, return REQUEST_CLARIFICATION.',
    'If the text does not describe a safe ledger action, return NO_ACTION.',
    'Output JSON only. No markdown, no commentary, no extra keys.',
    'Money is NGN and must be expressed in integer minor units.',
    'Dates must be ISO 8601 strings normalized to the supplied reference timezone.',
  ].join(' ');
}

export function buildAdvancedSystemPrompt(): string {
  return [
    'You are Talli Advanced, a state-aware ledger reasoning model for informal trade credit records.',
    'Your job is to propose one safe structured ledger intent that the application can validate and apply.',
    'Never invent customers, obligations, balances, or dates that are not supported by the provided context and utterance.',
    'Use stable customerId and obligationId values from the context whenever an existing entity is resolved.',
    'If a customer or obligation is materially ambiguous, request clarification instead of guessing.',
    'Corrections amend an existing obligation; they do not create a new debt.',
    'Partial payments reduce outstanding balance, and settlement must target the correct open obligation.',
    'Handle English and Nigerian Pidgin directly, including phrases like carry goods, bring 20k, don pay, remaining money, no be X na Y, and that money.',
    'Normalize temporal references relative to the supplied reference datetime and timezone.',
    'Output exactly one JSON object matching the LedgerAction schema. No markdown, no reasoning, no extra keys.',
    'Money is NGN and must be expressed in integer minor units.',
  ].join(' ');
}

export function buildBaselineUserPrompt(input: {
  utterance: string;
  referenceNow: string;
  timezone: string;
  language?: string;
}): string {
  return asJson({
    task: 'Extract a single safe LedgerAction from the utterance.',
    utterance: input.utterance,
    language: input.language ?? 'unknown',
    referenceClock: {
      referenceNow: input.referenceNow,
      timezone: input.timezone,
    },
    actionSemantics: {
      CREATE_OBLIGATION:
        'Create a new debt for a customer when the text clearly indicates a new credit sale.',
      RECORD_PAYMENT: 'Record a payment against one obligation only when the target is clear.',
      CORRECT_OBLIGATION:
        'Amend an existing obligation when the speaker is correcting the original amount.',
      SETTLE_OBLIGATION: 'Settle the remaining balance of a specific obligation.',
      REQUEST_CLARIFICATION: 'Use when the target customer, obligation, or amount is ambiguous.',
      NO_ACTION: 'Use when no safe ledger action can be inferred.',
    },
    moneyRules: {
      currency: 'NGN',
      minorUnits: true,
      example: formatNgn(50_000 * 100),
    },
    outputRules: [
      'Return a single JSON object only.',
      'Use integer minor units for all money values.',
      'Use ISO 8601 datetime strings for dueAt when present.',
      'Do not include hidden reasoning.',
    ],
  });
}

export function buildAdvancedUserPrompt(input: {
  utterance: string;
  context: AdvancedContextPackage;
  language?: string;
}): string {
  return asJson({
    task: 'Extract a safe LedgerAction using the supplied compact ledger context.',
    utterance: input.utterance,
    language: input.language ?? 'unknown',
    context: input.context,
    outputRules: [
      'Return a single JSON object only.',
      'Use stable customerId and obligationId values from the context when a target is resolved.',
      'If multiple plausible customers or obligations remain and mutating state would be unsafe, return REQUEST_CLARIFICATION.',
      'If correcting an amount, target the existing obligation and do not create a new debt.',
      'If payment would exceed the outstanding balance, request clarification rather than guessing.',
      'Use the compact context only; do not invent missing entities.',
    ],
  });
}

export function buildBaselineRequestEnvelope(input: {
  utterance: string;
  referenceNow: string;
  timezone: string;
  language?: string;
}): { systemInstructions: string; userInput: string } {
  return {
    systemInstructions: buildBaselineSystemPrompt(),
    userInput: buildBaselineUserPrompt(input),
  };
}

export function buildAdvancedRequestEnvelope(input: {
  utterance: string;
  context: AdvancedContextPackage;
  language?: string;
}): { systemInstructions: string; userInput: string } {
  return {
    systemInstructions: buildAdvancedSystemPrompt(),
    userInput: buildAdvancedUserPrompt(input),
  };
}

export type { AdvancedContextPackage, BaselineContextPackage };
