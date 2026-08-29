import { z } from 'zod';

export const actionSourceSchema = z.object({
  utterance: z.string().min(1),
  language: z.enum(['en', 'pcm', 'mixed']).optional(),
  turnId: z.string().min(1).optional(),
  actor: z.enum(['user', 'baseline', 'advanced', 'system']).optional(),
  rationale: z.string().min(1).optional(),
});

export const customerRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    kind: z.literal('id'),
    customerId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('name'),
    name: z.string().min(1),
    allowCreate: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('ambiguous'),
    candidateCustomerIds: z.array(z.string().min(1)).min(2),
    name: z.string().min(1).optional(),
  }),
]);

export const obligationRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('id'),
    obligationId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('latestOpenForCustomer'),
    customer: customerRefSchema,
  }),
  z.object({
    kind: z.literal('latestForCustomer'),
    customer: customerRefSchema,
  }),
  z.object({
    kind: z.literal('reference'),
    phrase: z.string().min(1),
    previousTurnId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('ambiguous'),
    candidateObligationIds: z.array(z.string().min(1)).min(2),
    phrase: z.string().min(1).optional(),
  }),
]);

const moneyMinorSchema = z.number().int().nonnegative();

const commonActionFields = {
  source: actionSourceSchema.optional(),
  permittedMutation: z.boolean().default(true),
  evidence: z.array(z.string().min(1)).default([]),
};

export const createObligationActionSchema = z.object({
  type: z.literal('CREATE_OBLIGATION'),
  customer: customerRefSchema,
  amountMinor: moneyMinorSchema,
  dueAt: z.string().datetime().nullable().optional(),
  ...commonActionFields,
});

export const recordPaymentActionSchema = z.object({
  type: z.literal('RECORD_PAYMENT'),
  customer: customerRefSchema.optional(),
  obligation: obligationRefSchema.optional(),
  amountMinor: moneyMinorSchema.optional(),
  settleRemaining: z.boolean().default(false),
  ...commonActionFields,
});

export const correctObligationActionSchema = z.object({
  type: z.literal('CORRECT_OBLIGATION'),
  obligation: obligationRefSchema,
  correctedAmountMinor: moneyMinorSchema,
  correctionReason: z.string().min(1).optional(),
  ...commonActionFields,
});

export const settleObligationActionSchema = z.object({
  type: z.literal('SETTLE_OBLIGATION'),
  obligation: obligationRefSchema,
  amountMinor: moneyMinorSchema.optional(),
  ...commonActionFields,
});

export const requestClarificationActionSchema = z.object({
  type: z.literal('REQUEST_CLARIFICATION'),
  question: z.string().min(1),
  ambiguityKind: z.enum(['customer', 'obligation', 'amount', 'correction', 'other']).optional(),
  candidateCustomerIds: z.array(z.string().min(1)).default([]),
  candidateObligationIds: z.array(z.string().min(1)).default([]),
  ...commonActionFields,
});

export const noActionSchema = z.object({
  type: z.literal('NO_ACTION'),
  reason: z.string().min(1).optional(),
  ...commonActionFields,
});

export const ledgerActionSchema = z.discriminatedUnion('type', [
  createObligationActionSchema,
  recordPaymentActionSchema,
  correctObligationActionSchema,
  settleObligationActionSchema,
  requestClarificationActionSchema,
  noActionSchema,
]);

export type ActionSource = z.infer<typeof actionSourceSchema>;
export type CustomerRef = z.infer<typeof customerRefSchema>;
export type ObligationRef = z.infer<typeof obligationRefSchema>;
export type CreateObligationAction = z.infer<typeof createObligationActionSchema>;
export type RecordPaymentAction = z.infer<typeof recordPaymentActionSchema>;
export type CorrectObligationAction = z.infer<typeof correctObligationActionSchema>;
export type SettleObligationAction = z.infer<typeof settleObligationActionSchema>;
export type RequestClarificationAction = z.infer<typeof requestClarificationActionSchema>;
export type NoAction = z.infer<typeof noActionSchema>;
export type LedgerAction = z.infer<typeof ledgerActionSchema>;
