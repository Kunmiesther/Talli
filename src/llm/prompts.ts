import type { AdvancedContextPackage, BaselineContextPackage } from './context.js';
import { LEDGER_INTENT_CONTRACT_NAME, ledgerIntentContractSummary } from './intent.js';

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

export function buildBaselineSystemPrompt(): string {
  return [
    `You are Talli Baseline. Output exactly one JSON object matching ${LEDGER_INTENT_CONTRACT_NAME}.`,
    'Use only the latest utterance and the supplied reference clock.',
    'Do not use ledger history, entity lists, or recent conversation context.',
    'If the target is ambiguous or unsafe, return request_clarification.',
    'If the text is not a ledger action, return no_action.',
    'JSON only. No markdown, no commentary, no extra keys.',
  ].join(' ');
}

export function buildAdvancedSystemPrompt(): string {
  return [
    `You are Talli Advanced. Output exactly one JSON object matching ${LEDGER_INTENT_CONTRACT_NAME}.`,
    'Use the supplied candidate-centered ledger context to resolve customers and obligations.',
    'Choose from the supplied customerCandidates and obligationCandidates when a target is already represented.',
    'Never invent customers, obligations, balances, or dates.',
    'If the target is materially ambiguous, return request_clarification.',
    'Corrections amend an existing obligation; settlements target the remaining balance; partial payments reduce it.',
    'English is the primary demonstration language.',
    'Normalize dates relative to the supplied reference clock only.',
    'JSON only. No markdown, no commentary, no extra keys.',
  ].join(' ');
}

export function buildBaselineUserPrompt(input: {
  utterance: string;
  referenceNow: string;
  timezone: string;
  language?: string;
}): string {
  return asJson({
    task: 'Extract one safe LedgerIntent from the utterance.',
    utterance: input.utterance,
    language: input.language ?? 'unknown',
    referenceClock: {
      referenceNow: input.referenceNow,
      timezone: input.timezone,
    },
    contract: ledgerIntentContractSummary(),
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
    task: 'Extract one safe LedgerIntent using the supplied candidate-centered ledger context.',
    utterance: input.utterance,
    language: input.language ?? 'unknown',
    referenceClock: input.context.clock,
    context: input.context,
    contract: ledgerIntentContractSummary(),
    outputRules: [
      'Return a single JSON object only.',
      'Use stable IDs from customerCandidates and obligationCandidates when a target is resolved.',
      'If the customer or obligation remains materially ambiguous, return request_clarification.',
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
