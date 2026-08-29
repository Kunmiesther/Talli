import { z } from 'zod';

export const LEDGER_INTENT_CONTRACT_NAME = 'LedgerIntent';
export const LEDGER_INTENT_CONTRACT_VERSION = '2026-08-29.intent-v1';

const modelRefIdSchema = z.string().min(1);
const moneyMinorSchema = z.number().int().nonnegative();

export const intentCustomerSchema = z
  .object({
    id: modelRefIdSchema.nullable().optional(),
    name: z.string().min(1).nullable().optional(),
    candidateIds: z.array(modelRefIdSchema).default([]),
  })
  .nullable()
  .optional();

export const intentObligationSchema = z
  .object({
    id: modelRefIdSchema.nullable().optional(),
    phrase: z.string().min(1).nullable().optional(),
    previousTurnId: z.string().min(1).nullable().optional(),
    candidateIds: z.array(modelRefIdSchema).default([]),
  })
  .nullable()
  .optional();

export const intentClarificationSchema = z
  .object({
    reason: z.string().min(1),
    candidateCustomerIds: z.array(modelRefIdSchema).default([]),
    candidateObligationIds: z.array(modelRefIdSchema).default([]),
  })
  .nullable()
  .optional();

export const ledgerIntentSchema = z.object({
  intent: z.enum([
    'create_obligation',
    'record_payment',
    'settle_obligation',
    'correct_obligation',
    'request_clarification',
    'no_action',
  ]),
  customer: intentCustomerSchema,
  obligation: intentObligationSchema,
  amountMinor: moneyMinorSchema.nullable().optional(),
  correctedAmountMinor: moneyMinorSchema.nullable().optional(),
  dueAt: z.string().min(1).nullable().optional(),
  settleRemaining: z.boolean().default(false),
  clarification: intentClarificationSchema,
  reason: z.string().min(1).nullable().optional(),
  correctionReason: z.string().min(1).nullable().optional(),
  evidence: z.array(z.string().min(1)).default([]),
});

export type LedgerIntent = z.infer<typeof ledgerIntentSchema>;
export type LedgerIntentCustomer = z.infer<typeof intentCustomerSchema>;
export type LedgerIntentObligation = z.infer<typeof intentObligationSchema>;
export type LedgerIntentClarification = z.infer<typeof intentClarificationSchema>;

export function ledgerIntentContractSummary(): Record<string, unknown> {
  return {
    contract: LEDGER_INTENT_CONTRACT_NAME,
    version: LEDGER_INTENT_CONTRACT_VERSION,
    intents: {
      create_obligation: ['customer.id or customer.name', 'amountMinor', 'dueAt optional'],
      record_payment: ['customer and/or obligation', 'amountMinor or settleRemaining'],
      settle_obligation: ['obligation', 'amountMinor optional'],
      correct_obligation: ['obligation', 'correctedAmountMinor', 'correctionReason optional'],
      request_clarification: ['clarification.reason', 'candidate ids optional'],
      no_action: ['reason optional'],
    },
    refs: {
      customer: ['id', 'name', 'candidateIds'],
      obligation: ['id', 'phrase', 'previousTurnId', 'candidateIds'],
    },
    moneyMinor: 'integer non-negative NGN minor units',
    temporal: 'ISO 8601 datetime strings normalized to the supplied reference clock',
  };
}
