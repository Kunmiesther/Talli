import {
  type CustomerRef,
  type LedgerAction,
  type ObligationRef,
  ledgerActionSchema,
} from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  type ObligationCreatedEvent,
  normalizeLedgerName,
} from '../domain/ledger.js';
import { type ReferenceClock, buildTemporalHints } from './context.js';
import type { LedgerIntent, LedgerIntentCustomer, LedgerIntentObligation } from './intent.js';
import type { ResolutionCandidatePackage } from './resolution-candidates.js';

export interface IntentCompilationRequest {
  intent: LedgerIntent;
  utterance: string;
  language: 'en' | 'pcm' | 'mixed';
  clock: ReferenceClock;
  snapshot: LedgerSnapshot;
  document: LedgerDocument;
  resolutionCandidates?: ResolutionCandidatePackage;
}

export interface IntentCompilationDiagnostics {
  outcome: 'action' | 'clarification' | 'no_action';
  reason: string;
  customerResolution: 'resolved' | 'ambiguous' | 'missing' | 'not_needed';
  obligationResolution: 'resolved' | 'ambiguous' | 'missing' | 'not_needed';
  customerRef?: CustomerRef | null;
  obligationRef?: ObligationRef | null;
  amountMinor?: number | null;
  correctedAmountMinor?: number | null;
  settleRemaining: boolean;
}

export interface IntentCompilationResult {
  action: LedgerAction;
  diagnostics: IntentCompilationDiagnostics;
}

function clarificationAction(
  question: string,
  ambiguityKind: 'customer' | 'obligation' | 'amount' | 'correction' | 'other' = 'other',
  candidateCustomerIds: string[] = [],
  candidateObligationIds: string[] = [],
): LedgerAction {
  return ledgerActionSchema.parse({
    type: 'REQUEST_CLARIFICATION',
    question,
    ambiguityKind,
    candidateCustomerIds,
    candidateObligationIds,
    permittedMutation: false,
    evidence: [],
  });
}

function noAction(reason?: string): LedgerAction {
  return ledgerActionSchema.parse({
    type: 'NO_ACTION',
    reason,
    permittedMutation: false,
    evidence: [],
  });
}

function normalizeCandidateIds(
  values: readonly string[] | undefined,
  allowedIds?: ReadonlySet<string> | null,
): string[] {
  const normalized = [
    ...new Set((values ?? []).filter((value): value is string => typeof value === 'string')),
  ];
  if (allowedIds) {
    return normalized
      .filter((value) => allowedIds.has(value))
      .sort((left, right) => left.localeCompare(right));
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function buildAllowedIdSet(values: readonly string[] | undefined): ReadonlySet<string> | null {
  if (values === undefined) {
    return null;
  }

  return new Set(normalizeCandidateIds(values));
}

function localMidnightIso(date: string): string {
  return new Date(`${date}T00:00:00+01:00`).toISOString();
}

function deriveDueAtFromUtterance(utterance: string, clock: ReferenceClock): string | null {
  const hints = buildTemporalHints(clock);
  const normalized = utterance.toLowerCase();
  if (/\bfriday\b/.test(normalized)) {
    return localMidnightIso(hints.nextFriday);
  }
  if (/\bmonday\b/.test(normalized)) {
    return localMidnightIso(hints.nextMonday);
  }
  if (/\btomorrow\b/.test(normalized)) {
    return localMidnightIso(hints.tomorrow);
  }
  if (/\btoday\b/.test(normalized)) {
    return localMidnightIso(hints.today);
  }
  if (/\byesterday\b/.test(normalized)) {
    return localMidnightIso(hints.yesterday);
  }
  return null;
}

function resolveCustomerForCreate(
  snapshot: LedgerSnapshot,
  customer: LedgerIntentCustomer,
  allowedCustomerIds?: ReadonlySet<string> | null,
):
  | { kind: 'resolved'; ref: CustomerRef }
  | { kind: 'new'; ref: CustomerRef }
  | { kind: 'clarify'; candidateCustomerIds: string[] }
  | { kind: 'missing' } {
  if (!customer) {
    return { kind: 'missing' };
  }

  const candidateIds = normalizeCandidateIds(customer.candidateIds, allowedCustomerIds);
  if (candidateIds.length === 1) {
    const customerId = candidateIds[0];
    if (!customerId) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', ref: { kind: 'id', customerId } };
  }
  if (candidateIds.length > 1) {
    return { kind: 'clarify', candidateCustomerIds: candidateIds };
  }

  if (customer.id) {
    if (allowedCustomerIds && !allowedCustomerIds.has(customer.id)) {
      return { kind: 'missing' };
    }
    const found = snapshot.customers.find((entry) => entry.id === customer.id);
    if (found) {
      return { kind: 'resolved', ref: { kind: 'id', customerId: found.id } };
    }
    return { kind: 'missing' };
  }

  if (!customer.name) {
    return { kind: 'missing' };
  }

  const normalized = normalizeLedgerName(customer.name);
  const matches = snapshot.customers.filter((entry) => {
    if (allowedCustomerIds && !allowedCustomerIds.has(entry.id)) {
      return false;
    }
    return entry.normalizedNames.includes(normalized);
  });
  if (matches.length === 1) {
    const single = matches[0];
    if (single) {
      return { kind: 'resolved', ref: { kind: 'id', customerId: single.id } };
    }
    return { kind: 'missing' };
  }
  if (matches.length > 1) {
    return { kind: 'clarify', candidateCustomerIds: matches.map((entry) => entry.id) };
  }

  return { kind: 'new', ref: { kind: 'new', name: customer.name, aliases: [] } };
}

function resolveCustomerForExisting(
  snapshot: LedgerSnapshot,
  customer: LedgerIntentCustomer,
  allowedCustomerIds?: ReadonlySet<string> | null,
):
  | { kind: 'resolved'; ref: CustomerRef }
  | { kind: 'clarify'; candidateCustomerIds: string[] }
  | { kind: 'missing' } {
  if (!customer) {
    return { kind: 'missing' };
  }

  const candidateIds = normalizeCandidateIds(customer.candidateIds, allowedCustomerIds);
  if (candidateIds.length === 1) {
    const customerId = candidateIds[0];
    if (!customerId) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', ref: { kind: 'id', customerId } };
  }
  if (candidateIds.length > 1) {
    return { kind: 'clarify', candidateCustomerIds: candidateIds };
  }

  if (customer.id) {
    if (allowedCustomerIds && !allowedCustomerIds.has(customer.id)) {
      return { kind: 'missing' };
    }
    const found = snapshot.customers.find((entry) => entry.id === customer.id);
    if (found) {
      return { kind: 'resolved', ref: { kind: 'id', customerId: found.id } };
    }
    return { kind: 'missing' };
  }

  if (!customer.name) {
    return { kind: 'missing' };
  }

  const normalized = normalizeLedgerName(customer.name);
  const matches = snapshot.customers.filter((entry) => {
    if (allowedCustomerIds && !allowedCustomerIds.has(entry.id)) {
      return false;
    }
    return entry.normalizedNames.includes(normalized);
  });
  if (matches.length === 1) {
    const single = matches[0];
    if (single) {
      return { kind: 'resolved', ref: { kind: 'id', customerId: single.id } };
    }
    return { kind: 'missing' };
  }
  if (matches.length > 1) {
    return { kind: 'clarify', candidateCustomerIds: matches.map((entry) => entry.id) };
  }

  return { kind: 'missing' };
}

function buildObligationReference(
  snapshot: LedgerSnapshot,
  document: LedgerDocument,
  obligation: LedgerIntentObligation,
  customerRef: CustomerRef | undefined,
  allowedObligationIds?: ReadonlySet<string> | null,
):
  | { kind: 'resolved'; ref: ObligationRef }
  | { kind: 'clarify'; candidateObligationIds: string[] }
  | { kind: 'missing' } {
  if (!obligation) {
    return { kind: 'missing' };
  }

  const candidateIds = normalizeCandidateIds(obligation.candidateIds, allowedObligationIds);
  if (candidateIds.length === 1) {
    const obligationId = candidateIds[0];
    if (!obligationId) {
      return { kind: 'missing' };
    }
    return { kind: 'resolved', ref: { kind: 'id', obligationId } };
  }
  if (candidateIds.length > 1) {
    return { kind: 'clarify', candidateObligationIds: candidateIds };
  }

  if (obligation.id) {
    if (allowedObligationIds && !allowedObligationIds.has(obligation.id)) {
      return { kind: 'missing' };
    }
    const found = snapshot.obligations.find((entry) => entry.id === obligation.id);
    if (found) {
      return { kind: 'resolved', ref: { kind: 'id', obligationId: found.id } };
    }
    return { kind: 'missing' };
  }

  if (obligation.previousTurnId) {
    const referencedObligationIds = document.events
      .filter(
        (event): event is ObligationCreatedEvent =>
          event.kind === 'obligation.created' && event.turnId === obligation.previousTurnId,
      )
      .map((event) => event.obligationId);

    if (referencedObligationIds.length === 1) {
      const obligationId = referencedObligationIds[0];
      if (!obligationId) {
        return { kind: 'missing' };
      }
      if (allowedObligationIds && !allowedObligationIds.has(obligationId)) {
        return { kind: 'missing' };
      }
      return {
        kind: 'resolved',
        ref: {
          kind: 'reference',
          phrase: obligation.phrase ?? 'previous turn reference',
          previousTurnId: obligation.previousTurnId,
        },
      };
    }

    if (referencedObligationIds.length > 1) {
      return { kind: 'clarify', candidateObligationIds: referencedObligationIds };
    }
  }

  if (obligation.phrase) {
    const normalizedPhrase = normalizeLedgerName(obligation.phrase);

    if (
      customerRef &&
      customerRef.kind === 'id' &&
      /remaining|full|settle|clear|everything/i.test(obligation.phrase)
    ) {
      const customerObligations = snapshot.obligations.filter(
        (entry) => entry.customerId === customerRef.customerId,
      );
      const openObligations = customerObligations.filter((entry) => entry.status === 'open');
      if (openObligations.length === 1) {
        const single = openObligations[0];
        if (single) {
          if (allowedObligationIds && !allowedObligationIds.has(single.id)) {
            return { kind: 'missing' };
          }
          return {
            kind: 'resolved',
            ref: { kind: 'id', obligationId: single.id },
          };
        }
      }
    }

    const nameMatches = snapshot.obligations.filter((entry) => {
      if (allowedObligationIds && !allowedObligationIds.has(entry.id)) {
        return false;
      }
      const obligationName = normalizeLedgerName(entry.customerName);
      return normalizedPhrase.includes(obligationName) || obligationName.includes(normalizedPhrase);
    });
    if (nameMatches.length === 1) {
      const single = nameMatches[0];
      if (!single) {
        return { kind: 'missing' };
      }
      return { kind: 'resolved', ref: { kind: 'id', obligationId: single.id } };
    }
    if (nameMatches.length > 1) {
      return { kind: 'clarify', candidateObligationIds: nameMatches.map((entry) => entry.id) };
    }
  }

  if (customerRef) {
    if (customerRef.kind === 'id') {
      const customerObligations = snapshot.obligations.filter(
        (entry) => entry.customerId === customerRef.customerId,
      );
      const openObligations = customerObligations.filter((entry) => entry.status === 'open');
      if (openObligations.length === 1) {
        return {
          kind: 'resolved',
          ref: { kind: 'latestOpenForCustomer', customer: customerRef },
        };
      }
      if (customerObligations.length === 1) {
        return {
          kind: 'resolved',
          ref: { kind: 'latestForCustomer', customer: customerRef },
        };
      }
      if (openObligations.length > 1) {
        return {
          kind: 'clarify',
          candidateObligationIds: normalizeCandidateIds(
            openObligations.map((entry) => entry.id),
            allowedObligationIds,
          ),
        };
      }
      if (customerObligations.length > 1) {
        const latestCreated = [...customerObligations]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .at(-1);
        if (latestCreated) {
          if (allowedObligationIds && !allowedObligationIds.has(latestCreated.id)) {
            return { kind: 'missing' };
          }
          return {
            kind: 'resolved',
            ref: { kind: 'latestForCustomer', customer: customerRef },
          };
        }
      }
    }
  }

  return { kind: 'missing' };
}

function createClarificationFromIntent(
  intent: LedgerIntent,
  fallback: string,
  allowedCustomerIds?: ReadonlySet<string> | null,
  allowedObligationIds?: ReadonlySet<string> | null,
): LedgerAction {
  const clarification = intent.clarification;
  return clarificationAction(
    clarification?.reason ?? intent.reason ?? fallback,
    'other',
    normalizeCandidateIds(clarification?.candidateCustomerIds, allowedCustomerIds),
    normalizeCandidateIds(clarification?.candidateObligationIds, allowedObligationIds),
  );
}

export function compileLedgerIntent(request: IntentCompilationRequest): IntentCompilationResult {
  const intent = request.intent;
  const allowedCustomerIds = buildAllowedIdSet(
    request.resolutionCandidates?.customerCandidates.map((candidate) => candidate.customerId),
  );
  const allowedObligationIds = buildAllowedIdSet(
    request.resolutionCandidates?.obligationCandidates.map((candidate) => candidate.obligationId),
  );
  const baseDiagnostics: IntentCompilationDiagnostics = {
    outcome: 'no_action',
    reason: 'No action compiled.',
    customerResolution: 'not_needed',
    obligationResolution: 'not_needed',
    settleRemaining: Boolean(intent.settleRemaining),
  };

  if (intent.intent === 'no_action') {
    const action = noAction(intent.reason ?? 'No action requested.');
    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'no_action',
        reason: intent.reason ?? 'No action requested.',
      },
    };
  }

  if (intent.intent === 'request_clarification') {
    const action = createClarificationFromIntent(
      intent,
      'Please clarify.',
      allowedCustomerIds,
      allowedObligationIds,
    );
    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'clarification',
        reason: intent.clarification?.reason ?? intent.reason ?? 'Please clarify.',
      },
    };
  }

  if (intent.intent === 'create_obligation') {
    const customer = resolveCustomerForCreate(
      request.snapshot,
      intent.customer,
      allowedCustomerIds,
    );
    if (customer.kind === 'clarify') {
      return {
        action: clarificationAction(
          'Which customer did you mean?',
          'customer',
          customer.candidateCustomerIds,
          [],
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Ambiguous customer for new obligation.',
          customerResolution: 'ambiguous',
        },
      };
    }

    if (customer.kind === 'missing') {
      return {
        action: clarificationAction('I need a customer identity to continue.', 'customer'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing customer for new obligation.',
          customerResolution: 'missing',
        },
      };
    }

    if (typeof intent.amountMinor !== 'number') {
      return {
        action: clarificationAction('How much is the new debt?', 'amount'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing amount for new obligation.',
          customerResolution: customer.kind === 'resolved' ? 'resolved' : 'missing',
        },
      };
    }

    const action = ledgerActionSchema.parse({
      type: 'CREATE_OBLIGATION',
      customer: customer.kind === 'resolved' ? customer.ref : customer.ref,
      amountMinor: intent.amountMinor,
      dueAt: deriveDueAtFromUtterance(request.utterance, request.clock) ?? intent.dueAt ?? null,
      permittedMutation: true,
      evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
      source: { utterance: request.utterance, language: request.language },
    });
    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'action',
        reason: 'Compiled create obligation intent.',
        customerResolution: customer.kind === 'resolved' ? 'resolved' : 'missing',
        customerRef: customer.ref,
        amountMinor: intent.amountMinor,
      },
    };
  }

  if (intent.intent === 'correct_obligation') {
    const obligation = buildObligationReference(
      request.snapshot,
      request.document,
      intent.obligation,
      undefined,
      allowedObligationIds,
    );
    if (obligation.kind === 'clarify') {
      return {
        action: clarificationAction(
          'Which obligation should I correct?',
          'obligation',
          [],
          obligation.candidateObligationIds,
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Ambiguous correction target.',
          obligationResolution: 'ambiguous',
        },
      };
    }

    if (obligation.kind === 'missing') {
      return {
        action: clarificationAction('I could not find the obligation to correct.', 'obligation'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing correction target.',
          obligationResolution: 'missing',
        },
      };
    }

    if (typeof intent.correctedAmountMinor !== 'number') {
      return {
        action: clarificationAction('What is the corrected amount?', 'correction'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing corrected amount.',
          obligationResolution: 'resolved',
        },
      };
    }

    const action = ledgerActionSchema.parse({
      type: 'CORRECT_OBLIGATION',
      obligation: obligation.ref,
      correctedAmountMinor: intent.correctedAmountMinor,
      correctionReason: intent.correctionReason ?? undefined,
      permittedMutation: true,
      evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
      source: { utterance: request.utterance, language: request.language },
    });
    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'action',
        reason: 'Compiled correction intent.',
        obligationResolution: 'resolved',
        obligationRef: obligation.ref,
        correctedAmountMinor: intent.correctedAmountMinor,
      },
    };
  }

  if (intent.intent === 'settle_obligation') {
    const customerRef = intent.customer
      ? resolveCustomerForExisting(request.snapshot, intent.customer, allowedCustomerIds)
      : { kind: 'missing' as const };
    const customer: CustomerRef | undefined =
      customerRef.kind === 'resolved'
        ? customerRef.ref
        : intent.customer?.id
          ? { kind: 'id', customerId: intent.customer.id }
          : intent.customer?.name
            ? { kind: 'name', name: intent.customer.name, allowCreate: false }
            : undefined;
    const obligation = buildObligationReference(
      request.snapshot,
      request.document,
      intent.obligation,
      customer,
      allowedObligationIds,
    );

    if (obligation.kind === 'clarify') {
      return {
        action: clarificationAction(
          'I could not safely resolve the debt to settle.',
          'obligation',
          [],
          obligation.candidateObligationIds,
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Ambiguous settlement target.',
          obligationResolution: 'ambiguous',
        },
      };
    }
    if (obligation.kind === 'missing') {
      return {
        action: clarificationAction('I could not safely resolve the debt to settle.', 'obligation'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing settlement target.',
          obligationResolution: 'missing',
        },
      };
    }

    const amountMinor = intent.amountMinor ?? null;
    const action = ledgerActionSchema.parse({
      type: 'SETTLE_OBLIGATION',
      obligation: obligation.ref,
      amountMinor: typeof amountMinor === 'number' ? amountMinor : undefined,
      permittedMutation: true,
      evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
      source: { utterance: request.utterance, language: request.language },
    });
    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'action',
        reason: 'Compiled settlement intent.',
        obligationResolution: 'resolved',
        obligationRef: obligation.ref,
        amountMinor: amountMinor ?? null,
      },
    };
  }

  if (intent.intent === 'record_payment') {
    const customerResolution = intent.customer
      ? resolveCustomerForExisting(request.snapshot, intent.customer)
      : { kind: 'missing' as const };
    if (customerResolution.kind === 'clarify') {
      return {
        action: clarificationAction(
          'Which customer did you mean?',
          'customer',
          customerResolution.candidateCustomerIds,
          [],
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Ambiguous customer for payment.',
          customerResolution: 'ambiguous',
          obligationResolution: 'missing',
        },
      };
    }
    const customerRef =
      customerResolution.kind === 'resolved'
        ? customerResolution.ref
        : intent.customer?.id
          ? ({ kind: 'id', customerId: intent.customer.id } as CustomerRef)
          : intent.customer?.name
            ? ({ kind: 'name', name: intent.customer.name, allowCreate: false } as CustomerRef)
            : undefined;

    const obligation = buildObligationReference(
      request.snapshot,
      request.document,
      intent.obligation,
      customerRef,
      allowedObligationIds,
    );
    if (obligation.kind === 'clarify') {
      return {
        action: clarificationAction(
          'Which obligation should I apply this payment to?',
          'obligation',
          [],
          obligation.candidateObligationIds,
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Ambiguous obligation for payment.',
          obligationResolution: 'ambiguous',
          customerResolution: customerResolution.kind === 'resolved' ? 'resolved' : 'missing',
        },
      };
    }

    if (obligation.kind === 'missing') {
      if (customerRef && customerRef.kind === 'id') {
        const customerObligations = request.snapshot.obligations.filter(
          (entry) => entry.customerId === customerRef.customerId,
        );
        const openObligations = customerObligations.filter((entry) => entry.status === 'open');
        if (openObligations.length === 1) {
          const action = ledgerActionSchema.parse({
            type: 'RECORD_PAYMENT',
            customer: customerRef,
            obligation: { kind: 'latestOpenForCustomer', customer: customerRef },
            amountMinor: intent.amountMinor ?? undefined,
            settleRemaining: Boolean(intent.settleRemaining),
            permittedMutation: true,
            evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
            source: { utterance: request.utterance, language: request.language },
          });
          return {
            action,
            diagnostics: {
              ...baseDiagnostics,
              outcome: 'action',
              reason: 'Compiled payment intent against the unique open obligation.',
              customerResolution: 'resolved',
              obligationResolution: 'resolved',
              customerRef,
              amountMinor: intent.amountMinor ?? null,
              settleRemaining: Boolean(intent.settleRemaining),
            },
          };
        }

        if (openObligations.length > 1) {
          return {
            action: clarificationAction(
              'Which debt should I apply the payment to?',
              'obligation',
              [],
              openObligations.map((entry) => entry.id),
            ),
            diagnostics: {
              ...baseDiagnostics,
              outcome: 'clarification',
              reason: 'Multiple open obligations for the same customer.',
              customerResolution: 'resolved',
              obligationResolution: 'ambiguous',
            },
          };
        }

        if (customerObligations.length === 1) {
          const action = ledgerActionSchema.parse({
            type: 'RECORD_PAYMENT',
            customer: customerRef,
            obligation: { kind: 'latestForCustomer', customer: customerRef },
            amountMinor: intent.amountMinor ?? undefined,
            settleRemaining: Boolean(intent.settleRemaining),
            permittedMutation: true,
            evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
            source: { utterance: request.utterance, language: request.language },
          });
          return {
            action,
            diagnostics: {
              ...baseDiagnostics,
              outcome: 'action',
              reason: 'Compiled payment intent against the only known customer obligation.',
              customerResolution: 'resolved',
              obligationResolution: 'resolved',
              customerRef,
              amountMinor: intent.amountMinor ?? null,
              settleRemaining: Boolean(intent.settleRemaining),
            },
          };
        }
      }

      return {
        action: clarificationAction(
          'I could not resolve the target debt for this payment.',
          'obligation',
        ),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing payment target.',
          customerResolution: customerResolution.kind === 'resolved' ? 'resolved' : 'missing',
          obligationResolution: 'missing',
        },
      };
    }

    if (typeof intent.amountMinor !== 'number' && !intent.settleRemaining) {
      return {
        action: clarificationAction('How much was paid?', 'amount'),
        diagnostics: {
          ...baseDiagnostics,
          outcome: 'clarification',
          reason: 'Missing payment amount.',
          customerResolution: customerResolution.kind === 'resolved' ? 'resolved' : 'missing',
          obligationResolution: 'resolved',
          customerRef,
          obligationRef: obligation.ref,
        },
      };
    }

    const action = ledgerActionSchema.parse({
      type: intent.settleRemaining ? 'SETTLE_OBLIGATION' : 'RECORD_PAYMENT',
      customer: customerRef,
      obligation: obligation.ref,
      amountMinor: intent.amountMinor ?? undefined,
      settleRemaining: Boolean(intent.settleRemaining),
      permittedMutation: true,
      evidence: intent.evidence.length > 0 ? [...intent.evidence] : [request.utterance],
      source: { utterance: request.utterance, language: request.language },
    });

    return {
      action,
      diagnostics: {
        ...baseDiagnostics,
        outcome: 'action',
        reason: 'Compiled payment intent.',
        customerResolution: customerResolution.kind === 'resolved' ? 'resolved' : 'missing',
        obligationResolution: 'resolved',
        customerRef,
        obligationRef: obligation.ref,
        amountMinor: intent.amountMinor ?? null,
        settleRemaining: Boolean(intent.settleRemaining),
      },
    };
  }

  return {
    action: noAction('No action requested.'),
    diagnostics: {
      ...baseDiagnostics,
      outcome: 'no_action',
      reason: 'Unsupported intent.',
    },
  };
}
