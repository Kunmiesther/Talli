import {
  type CustomerRecord,
  type LedgerDocument,
  type LedgerEvent,
  type LedgerSnapshot,
  type ObligationRecord,
  normalizeLedgerName,
} from '../domain/ledger.js';
import { nairaToMinorUnits } from '../domain/money.js';
import type { PendingClarificationContext, ReferenceClock } from './context.js';

export interface ResolutionRelevantEvent {
  id: string;
  kind: LedgerEvent['kind'];
  timestamp: string;
  turnId: string | null;
  summary: string;
}

export interface ResolutionCustomerCandidate {
  customerId: string;
  displayName: string;
  aliases: string[];
  reasonCodes: string[];
  openObligationIds: string[];
  settledObligationIds: string[];
  totalOutstandingMinor: number;
  latestActivityAt: string | null;
}

export interface ResolutionObligationCandidate {
  obligationId: string;
  customerId: string;
  customerDisplayName: string;
  customerAliases: string[];
  status: ObligationRecord['status'];
  originalAmountMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  customerObligationOrdinal: number;
  customerOpenOrdinal: number | null;
  reasonCodes: string[];
  recentRelevantEvent: ResolutionRelevantEvent | null;
}

export interface ResolutionCandidatePackage {
  currentUtterance: string;
  language: string;
  recentTurns: Array<{
    turnId: string;
    index: number;
    text: string;
  }>;
  customerCandidates: ResolutionCustomerCandidate[];
  obligationCandidates: ResolutionObligationCandidate[];
  selectionNotes: string[];
}

interface CustomerScore {
  customer: CustomerRecord;
  score: number;
  reasonCodes: Set<string>;
}

interface ObligationScore {
  obligation: ObligationRecord;
  score: number;
  reasonCodes: Set<string>;
  customerObligationOrdinal: number;
  customerOpenOrdinal: number | null;
}

function normalizeTexts(texts: string[]): string {
  return normalizeLedgerName(texts.join(' '));
}

function extractAmountHints(utterance: string): number[] {
  const normalized = utterance.toLowerCase();
  const hints: number[] = [];
  const regex = /(\d+(?:\.\d+)?)\s*(k|thousand)?\b/g;
  for (const match of normalized.matchAll(regex)) {
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) {
      continue;
    }

    const inNaira = match[2] ? numeric * 1000 : numeric;
    const minor = nairaToMinorUnits(Math.round(inNaira));
    hints.push(minor);
  }

  return [...new Set(hints)];
}

function hasPronounCue(text: string): boolean {
  return /\b(she|he|they|her|him|them|it|that|this|na|dem|am|im|dey|e)\b/i.test(text);
}

function hasReferenceCue(text: string): boolean {
  return /\b(remaining|rest|balance|that money|the one|first one|last week|earlier|settle|full|everything|another|again|from that|before monday)\b/i.test(
    text,
  );
}

function hasCorrectionCue(text: string): boolean {
  return /\b(actually|rather|not|wasn't|wasnt|meant|no be|correction|i said|i talk|it was)\b/i.test(
    text,
  );
}

function hasPaymentCue(text: string): boolean {
  return /\b(pay|paid|brought|bring|settle|clear|send|gave|given|owe|owing)\b/i.test(text);
}

function customerActivityTimestamp(snapshot: LedgerSnapshot, customerId: string): string | null {
  const customerObligations = snapshot.obligations.filter(
    (obligation) => obligation.customerId === customerId,
  );
  const latest = customerObligations
    .flatMap((obligation) => [obligation.createdAt, obligation.updatedAt])
    .sort()
    .at(-1);
  return latest ?? null;
}

function summarizeEvent(event: LedgerEvent): string {
  switch (event.kind) {
    case 'customer.created':
      return `customer ${event.displayName} created`;
    case 'obligation.created':
      return `obligation ${event.obligationId} created ${event.originalAmountMinor}${event.dueAt ? ` due ${event.dueAt}` : ''}`;
    case 'payment.recorded':
      return `payment ${event.amountMinor} recorded (${event.outstandingBeforeMinor} -> ${event.outstandingAfterMinor})`;
    case 'obligation.corrected':
      return `obligation ${event.obligationId} corrected from ${event.previousAmountMinor} to ${event.correctedAmountMinor}`;
    case 'decision.clarification_requested':
      return `clarification requested: ${event.question}`;
    case 'decision.no_action':
      return `no action${event.reason ? `: ${event.reason}` : ''}`;
    default: {
      const never: never = event;
      return never;
    }
  }
}

function getRecentRelevantEvent(
  obligation: ObligationRecord,
  document: LedgerDocument,
): ResolutionRelevantEvent | null {
  const eventIds = [
    ...obligation.correctionEventIds.slice(-1),
    ...obligation.paymentEventIds.slice(-1),
    ...obligation.sourceEventIds.slice(-1),
  ];

  for (const eventId of eventIds) {
    const event = document.events.find((entry) => entry.id === eventId);
    if (!event) {
      continue;
    }

    return {
      id: event.id,
      kind: event.kind,
      timestamp: event.timestamp,
      turnId: 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null,
      summary: summarizeEvent(event),
    };
  }

  return null;
}

function scoredCustomers(
  snapshot: LedgerSnapshot,
  utterance: string,
  recentTurns: Array<{ turnId: string; text: string }>,
  pendingClarification: PendingClarificationContext | null,
): CustomerScore[] {
  const normalizedUtterance = normalizeLedgerName(utterance);
  const normalizedRecentTurns = normalizeTexts(recentTurns.slice(-4).map((turn) => turn.text));
  const pronounCue = hasPronounCue(utterance);
  const referenceCue = hasReferenceCue(utterance) || hasCorrectionCue(utterance);
  const customerMentionsInRecentTurns = new Set<string>();

  for (const turn of recentTurns.slice(-4)) {
    const normalizedTurn = normalizeLedgerName(turn.text);
    for (const customer of snapshot.customers) {
      const normalizedNames = [customer.displayName, ...customer.aliases].map(normalizeLedgerName);
      if (normalizedNames.some((name) => normalizedTurn.includes(name))) {
        customerMentionsInRecentTurns.add(customer.id);
      }
    }
  }

  return snapshot.customers
    .map((customer) => {
      const normalizedNames = [customer.displayName, ...customer.aliases].map(normalizeLedgerName);
      let score = 0;
      const reasonCodes = new Set<string>();

      if (normalizedNames.includes(normalizedUtterance)) {
        score += 100;
        reasonCodes.add('utterance_exact_name');
      }

      if (normalizedNames.some((name) => normalizedUtterance.includes(name))) {
        score += 60;
        reasonCodes.add('utterance_contains_name');
      }

      if (normalizedNames.some((name) => normalizedRecentTurns.includes(name))) {
        score += 35;
        reasonCodes.add('recent_turn_name');
      }

      if (customerMentionsInRecentTurns.has(customer.id)) {
        score += 25;
        reasonCodes.add('recent_turn_reference');
      }

      const openObligations = snapshot.obligations.filter(
        (obligation) => obligation.customerId === customer.id && obligation.status === 'open',
      );
      const settledObligations = snapshot.obligations.filter(
        (obligation) => obligation.customerId === customer.id && obligation.status === 'settled',
      );

      if (openObligations.length > 0) {
        score += 12;
        reasonCodes.add('has_open_obligation');
      }
      if (settledObligations.length > 0) {
        score += 5;
        reasonCodes.add('has_settled_obligation');
      }
      if (pronounCue && customerMentionsInRecentTurns.has(customer.id)) {
        score += 15;
        reasonCodes.add('pronoun_with_recent_reference');
      }
      if (referenceCue && customerMentionsInRecentTurns.has(customer.id)) {
        score += 10;
        reasonCodes.add('reference_language_with_recent_reference');
      }
      if (customer.id === snapshot.customers.at(-1)?.id) {
        score += 4;
        reasonCodes.add('latest_customer');
      }
      if (pendingClarification?.candidateCustomerIds.includes(customer.id)) {
        score += 40;
        reasonCodes.add('pending_clarification_customer');
      }
      if (customerActivityTimestamp(snapshot, customer.id)) {
        score += 2;
        reasonCodes.add('has_activity');
      }

      return {
        customer,
        score,
        reasonCodes,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.customer.id.localeCompare(right.customer.id);
    });
}

function selectCustomerCandidates(
  snapshot: LedgerSnapshot,
  utterance: string,
  recentTurns: Array<{ turnId: string; text: string }>,
  pendingClarification: PendingClarificationContext | null,
): CustomerScore[] {
  const scored = scoredCustomers(snapshot, utterance, recentTurns, pendingClarification);
  if (scored.length === 0) {
    return [];
  }

  const topScore = scored[0]?.score ?? 0;
  const threshold = Math.max(8, topScore - 25);
  const retained = scored.filter((entry) => entry.score >= threshold);
  return retained.slice(0, 5);
}

function obligationOrderForCustomer(
  obligations: ObligationRecord[],
  customerId: string,
): Map<string, number> {
  const ordered = [...obligations]
    .filter((obligation) => obligation.customerId === customerId)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.id.localeCompare(right.id);
    });
  return new Map(ordered.map((obligation, index) => [obligation.id, index + 1]));
}

function scoreObligations(
  snapshot: LedgerSnapshot,
  document: LedgerDocument,
  selectedCustomers: CustomerRecord[],
  utterance: string,
  recentTurns: Array<{ turnId: string; text: string }>,
  clock: ReferenceClock,
  pendingClarification: PendingClarificationContext | null,
): ObligationScore[] {
  const normalizedUtterance = normalizeLedgerName(utterance);
  const referenceCue = hasReferenceCue(utterance);
  const correctionCue = hasCorrectionCue(utterance);
  const paymentCue = hasPaymentCue(utterance);
  const amountHints = extractAmountHints(utterance);
  const recentTurnTexts = normalizeTexts(recentTurns.slice(-4).map((turn) => turn.text));
  const selectedCustomerIds = new Set(selectedCustomers.map((customer) => customer.id));
  const fallbackCustomerIds =
    selectedCustomerIds.size > 0
      ? selectedCustomerIds
      : new Set(
          [...snapshot.obligations]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, 3)
            .map((obligation) => obligation.customerId),
        );

  return snapshot.obligations
    .filter((obligation) => fallbackCustomerIds.has(obligation.customerId))
    .map((obligation) => {
      let score = 0;
      const reasonCodes = new Set<string>();
      const customer = snapshot.customers.find((entry) => entry.id === obligation.customerId);
      const customerNames = customer
        ? [customer.displayName, ...customer.aliases].map(normalizeLedgerName)
        : [normalizeLedgerName(obligation.customerName)];
      const customerOrder = obligationOrderForCustomer(snapshot.obligations, obligation.customerId);
      const customerObligationOrdinal = customerOrder.get(obligation.id) ?? 1;
      const customerOpenOrdinal = [
        ...snapshot.obligations
          .filter((entry) => entry.customerId === obligation.customerId && entry.status === 'open')
          .sort((left, right) => {
            if (left.createdAt !== right.createdAt) {
              return left.createdAt.localeCompare(right.createdAt);
            }
            return left.id.localeCompare(right.id);
          }),
      ].findIndex((entry) => entry.id === obligation.id);

      if (obligation.status === 'open') {
        score += 35;
        reasonCodes.add('open_obligation');
      } else {
        score += 8;
        reasonCodes.add('settled_obligation');
      }
      if (obligation.outstandingMinor > 0) {
        score += 12;
        reasonCodes.add('positive_outstanding_balance');
      }
      if (referenceCue && obligation.status === 'open') {
        score += 20;
        reasonCodes.add('reference_language_open_debt');
      }
      if (referenceCue && obligation.status === 'settled') {
        score += 8;
        reasonCodes.add('reference_language_settled_debt');
      }
      if (correctionCue && obligation.correctionEventIds.length > 0) {
        score += 22;
        reasonCodes.add('correction_history');
      }
      if (paymentCue && obligation.paymentEventIds.length > 0) {
        score += 12;
        reasonCodes.add('payment_history');
      }
      if (normalizedUtterance.includes(normalizeLedgerName(obligation.customerName))) {
        score += 18;
        reasonCodes.add('utterance_customer_name');
      }
      if (customerNames.some((name) => recentTurnTexts.includes(name))) {
        score += 10;
        reasonCodes.add('recent_turn_customer_reference');
      }
      for (const amountHint of amountHints) {
        if (
          amountHint === obligation.originalAmountMinor ||
          amountHint === obligation.outstandingMinor ||
          amountHint === obligation.totalPaidMinor
        ) {
          score += 25;
          reasonCodes.add('amount_hint_match');
        }
      }
      if (obligation.dueAt) {
        score += 4;
        reasonCodes.add('has_due_date');
      }
      if (customerObligationOrdinal === 1) {
        score += 5;
        reasonCodes.add('first_obligation_for_customer');
      } else if (customerObligationOrdinal > 1) {
        score += 2;
        reasonCodes.add('later_obligation_for_customer');
      }
      if (customerOpenOrdinal === 0) {
        score += 4;
        reasonCodes.add('first_open_obligation_for_customer');
      } else if (customerOpenOrdinal > 0) {
        score += 1;
        reasonCodes.add('later_open_obligation_for_customer');
      }
      if (customer?.id === snapshot.customers.at(-1)?.id) {
        score += 3;
      }
      if (customer && clock.referenceNow >= obligation.createdAt) {
        score += 1;
      }
      if (pendingClarification?.candidateObligationIds.includes(obligation.id)) {
        score += 40;
        reasonCodes.add('pending_clarification_obligation');
      }

      return {
        obligation,
        score,
        reasonCodes,
        customerObligationOrdinal,
        customerOpenOrdinal: customerOpenOrdinal >= 0 ? customerOpenOrdinal + 1 : null,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.obligation.customerId !== right.obligation.customerId) {
        return left.obligation.customerId.localeCompare(right.obligation.customerId);
      }
      if (left.obligation.createdAt !== right.obligation.createdAt) {
        return left.obligation.createdAt.localeCompare(right.obligation.createdAt);
      }
      return left.obligation.id.localeCompare(right.obligation.id);
    });
}

function selectObligationCandidates(
  snapshot: LedgerSnapshot,
  document: LedgerDocument,
  selectedCustomers: CustomerRecord[],
  utterance: string,
  recentTurns: Array<{ turnId: string; text: string }>,
  clock: ReferenceClock,
  pendingClarification: PendingClarificationContext | null,
): ObligationScore[] {
  const scored = scoreObligations(
    snapshot,
    document,
    selectedCustomers,
    utterance,
    recentTurns,
    clock,
    pendingClarification,
  );
  if (scored.length === 0) {
    return [];
  }

  const grouped = new Map<string, ObligationScore[]>();
  for (const entry of scored) {
    const current = grouped.get(entry.obligation.customerId) ?? [];
    current.push(entry);
    grouped.set(entry.obligation.customerId, current);
  }

  const retained: ObligationScore[] = [];
  for (const customerEntries of grouped.values()) {
    retained.push(...customerEntries.slice(0, 3));
  }

  const unique = new Map<string, ObligationScore>();
  for (const entry of retained.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.obligation.customerId !== right.obligation.customerId) {
      return left.obligation.customerId.localeCompare(right.obligation.customerId);
    }
    return left.obligation.id.localeCompare(right.obligation.id);
  })) {
    unique.set(entry.obligation.id, entry);
  }

  return [...unique.values()].slice(0, 8);
}

export function buildResolutionCandidates(input: {
  snapshot: LedgerSnapshot;
  document: LedgerDocument;
  recentTurns: Array<{
    turnId: string;
    text: string;
  }>;
  utterance: string;
  language: string;
  clock: ReferenceClock;
  pendingClarification?: PendingClarificationContext | null;
}): ResolutionCandidatePackage {
  const recentTurns = input.recentTurns.slice(-4).map((turn, index, array) => ({
    turnId: turn.turnId,
    index: input.recentTurns.length - array.length + index + 1,
    text: turn.text,
  }));
  const pendingClarification = input.pendingClarification ?? null;
  const customerScores = selectCustomerCandidates(
    input.snapshot,
    input.utterance,
    input.recentTurns,
    pendingClarification,
  );
  const customerCandidates = customerScores.map((entry) => {
    const customerObligations = input.snapshot.obligations.filter(
      (obligation) => obligation.customerId === entry.customer.id,
    );
    const openObligationIds = customerObligations
      .filter((obligation) => obligation.status === 'open')
      .map((obligation) => obligation.id);
    const settledObligationIds = customerObligations
      .filter((obligation) => obligation.status === 'settled')
      .map((obligation) => obligation.id);
    const totalOutstandingMinor = customerObligations.reduce(
      (sum, obligation) => sum + obligation.outstandingMinor,
      0,
    );

    return {
      customerId: entry.customer.id,
      displayName: entry.customer.displayName,
      aliases: [...entry.customer.aliases],
      reasonCodes: [...entry.reasonCodes].sort(),
      openObligationIds,
      settledObligationIds,
      totalOutstandingMinor,
      latestActivityAt: customerActivityTimestamp(input.snapshot, entry.customer.id),
    };
  });

  const selectedCustomers = customerScores.map((entry) => entry.customer);
  const obligationScores = selectObligationCandidates(
    input.snapshot,
    input.document,
    selectedCustomers,
    input.utterance,
    input.recentTurns,
    input.clock,
    pendingClarification,
  );

  const obligationCandidates = obligationScores.map((entry) => ({
    obligationId: entry.obligation.id,
    customerId: entry.obligation.customerId,
    customerDisplayName: entry.obligation.customerName,
    customerAliases:
      input.snapshot.customers.find((customer) => customer.id === entry.obligation.customerId)
        ?.aliases ?? [],
    status: entry.obligation.status,
    originalAmountMinor: entry.obligation.originalAmountMinor,
    paidMinor: entry.obligation.totalPaidMinor,
    outstandingMinor: entry.obligation.outstandingMinor,
    dueAt: entry.obligation.dueAt ?? null,
    createdAt: entry.obligation.createdAt,
    updatedAt: entry.obligation.updatedAt,
    customerObligationOrdinal: entry.customerObligationOrdinal,
    customerOpenOrdinal: entry.customerOpenOrdinal,
    reasonCodes: [...entry.reasonCodes].sort(),
    recentRelevantEvent: getRecentRelevantEvent(entry.obligation, input.document),
  }));

  const selectionNotes = [
    'Choose only from the supplied candidate IDs when a target is already represented.',
    'If the target is still materially ambiguous, return request_clarification.',
    `Customer candidates: ${customerCandidates.length}; obligation candidates: ${obligationCandidates.length}.`,
  ];

  if (pendingClarification) {
    selectionNotes.push(
      `Pending clarification: ${pendingClarification.question} (customers=${pendingClarification.candidateCustomerIds.length}, obligations=${pendingClarification.candidateObligationIds.length}).`,
    );
  }

  return {
    currentUtterance: input.utterance,
    language: input.language,
    recentTurns,
    customerCandidates,
    obligationCandidates,
    selectionNotes,
  };
}
