import {
  type CustomerRecord,
  type LedgerDocument,
  type LedgerEvent,
  type LedgerSnapshot,
  type ObligationRecord,
  normalizeLedgerName,
} from '../domain/ledger.js';
import { formatNgn } from '../domain/money.js';
import {
  type ResolutionCandidatePackage,
  buildResolutionCandidates,
} from './resolution-candidates.js';

export interface ReferenceClock {
  referenceNow: string;
  timezone: string;
}

export interface CompactCustomerContext {
  id: string;
  displayName: string;
  aliases: string[];
  openObligationIds: string[];
  settledObligationIds: string[];
  totalOutstandingMinor: number;
  latestActivityAt: string | null;
}

export interface CompactObligationContext {
  id: string;
  customerId: string;
  customerName: string;
  status: ObligationRecord['status'];
  originalAmountMinor: number;
  totalPaidMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastPaymentEventId: string | null;
}

export interface CompactEventContext {
  id: string;
  kind: LedgerEvent['kind'];
  timestamp: string;
  turnId: string | undefined;
  customerId: string | null;
  obligationId: string | null;
  summary: string;
}

export interface AdvancedContextPackage extends ResolutionCandidatePackage {
  clock: ReferenceClock;
  currentUtterance: string;
  language: string;
  referenceDate: string;
  referenceWeekday: string;
  temporalHints: {
    today: string;
    yesterday: string;
    tomorrow: string;
    nextFriday: string;
    nextMonday: string;
  };
  recentTurns: Array<{
    turnId: string;
    index: number;
    text: string;
  }>;
}

export interface BaselineContextPackage {
  clock: ReferenceClock;
  currentUtterance: string;
  language: string;
}

interface ScoredCustomer {
  customer: CustomerRecord;
  score: number;
}

function formatDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatWeekday(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(date);
}

function shiftDays(reference: Date, days: number): Date {
  return new Date(reference.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextWeekday(reference: Date, timezone: string, weekday: string): string {
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = shiftDays(reference, offset);
    if (formatWeekday(candidate, timezone) === weekday) {
      return formatDay(candidate, timezone);
    }
  }

  return formatDay(reference, timezone);
}

function summarizeEvent(event: LedgerEvent, snapshot: LedgerSnapshot): string {
  switch (event.kind) {
    case 'customer.created':
      return `customer ${event.displayName} (${event.customerId}) created`;
    case 'obligation.created':
      return `obligation ${event.obligationId} for ${snapshot.obligations.find((obligation) => obligation.id === event.obligationId)?.customerName ?? event.customerId} created ${formatNgn(event.originalAmountMinor)}${event.dueAt ? ` due ${event.dueAt}` : ''}`;
    case 'payment.recorded':
      return `payment ${event.amountMinor} recorded for ${event.obligationId} (${event.outstandingBeforeMinor} -> ${event.outstandingAfterMinor})`;
    case 'obligation.corrected':
      return `obligation ${event.obligationId} corrected from ${formatNgn(event.previousAmountMinor)} to ${formatNgn(event.correctedAmountMinor)}`;
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

function getCustomerActivityTimestamp(snapshot: LedgerSnapshot, customerId: string): string | null {
  const customerObligations = snapshot.obligations.filter(
    (obligation) => obligation.customerId === customerId,
  );
  const latest = customerObligations
    .flatMap((obligation) => [obligation.createdAt, obligation.updatedAt])
    .sort()
    .at(-1);
  return latest ?? null;
}

function selectCustomers(
  snapshot: LedgerSnapshot,
  utterance: string,
  recentTexts: string[],
): ScoredCustomer[] {
  const normalizedUtterance = normalizeLedgerName(utterance);
  const normalizedRecentText = normalizeLedgerName(recentTexts.slice(-3).join(' '));

  return snapshot.customers
    .map((customer) => {
      const normalizedNames = [customer.displayName, ...customer.aliases].map(normalizeLedgerName);
      let score = 0;

      if (normalizedNames.includes(normalizedUtterance)) {
        score += 100;
      }

      if (normalizedNames.some((name) => normalizedUtterance.includes(name))) {
        score += 60;
      }

      if (normalizedNames.some((name) => normalizedRecentText.includes(name))) {
        score += 25;
      }

      const openObligations = snapshot.obligations.filter(
        (obligation) => obligation.customerId === customer.id && obligation.status === 'open',
      );
      const settledObligations = snapshot.obligations.filter(
        (obligation) => obligation.customerId === customer.id && obligation.status === 'settled',
      );

      score += openObligations.length * 10;
      score += settledObligations.length * 4;
      if (customer.id === snapshot.customers.at(-1)?.id) {
        score += 6;
      }

      return { customer, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.customer.id.localeCompare(right.customer.id);
    });
}

function selectRelevantObligations(
  snapshot: LedgerSnapshot,
  selectedCustomers: CustomerRecord[],
  utterance: string,
): ObligationRecord[] {
  const normalizedUtterance = normalizeLedgerName(utterance);
  const referenceCue =
    /\b(remaining|balance|rest|that money|the one|the first one|from that|last week|earlier|settle|full|everything|another|again)\b/i.test(
      utterance,
    );

  const customerIds = new Set(selectedCustomers.map((customer) => customer.id));
  const obligations = snapshot.obligations.filter((obligation) =>
    customerIds.has(obligation.customerId),
  );
  const scored = obligations.map((obligation) => {
    let score = 0;
    if (obligation.status === 'open') {
      score += 30;
    } else {
      score += 6;
    }
    if (referenceCue && obligation.status === 'open') {
      score += 20;
    }
    if (referenceCue && obligation.status === 'settled') {
      score += 14;
    }
    if (normalizedUtterance.includes(normalizeLedgerName(obligation.customerName))) {
      score += 25;
    }
    if (obligation.outstandingMinor > 0) {
      score += 10;
    }
    if (obligation.dueAt) {
      score += 3;
    }
    return { obligation, score };
  });

  return scored
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.obligation.updatedAt !== left.obligation.updatedAt) {
        return right.obligation.updatedAt.localeCompare(left.obligation.updatedAt);
      }
      return left.obligation.id.localeCompare(right.obligation.id);
    })
    .slice(0, 8)
    .map((entry) => entry.obligation);
}

function buildCustomerContexts(
  snapshot: LedgerSnapshot,
  selectedCustomers: CustomerRecord[],
): CompactCustomerContext[] {
  return selectedCustomers.map((customer) => {
    const customerObligations = snapshot.obligations.filter(
      (obligation) => obligation.customerId === customer.id,
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
      id: customer.id,
      displayName: customer.displayName,
      aliases: [...customer.aliases],
      openObligationIds,
      settledObligationIds,
      totalOutstandingMinor,
      latestActivityAt: getCustomerActivityTimestamp(snapshot, customer.id),
    };
  });
}

function buildObligationContexts(obligations: ObligationRecord[]): CompactObligationContext[] {
  return obligations.map((obligation) => ({
    id: obligation.id,
    customerId: obligation.customerId,
    customerName: obligation.customerName,
    status: obligation.status,
    originalAmountMinor: obligation.originalAmountMinor,
    totalPaidMinor: obligation.totalPaidMinor,
    outstandingMinor: obligation.outstandingMinor,
    dueAt: obligation.dueAt ?? null,
    createdAt: obligation.createdAt,
    updatedAt: obligation.updatedAt,
    lastPaymentEventId: obligation.paymentEventIds.at(-1) ?? null,
  }));
}

function buildRecentEvents(
  snapshot: LedgerSnapshot,
  document: LedgerDocument,
): CompactEventContext[] {
  return document.events.slice(-10).map((event) => {
    let customerId: string | null = null;
    let obligationId: string | null = null;

    switch (event.kind) {
      case 'customer.created':
        customerId = event.customerId;
        break;
      case 'obligation.created':
        customerId = event.customerId;
        obligationId = event.obligationId;
        break;
      case 'payment.recorded':
        customerId = event.customerId;
        obligationId = event.obligationId;
        break;
      case 'obligation.corrected':
        customerId = event.customerId;
        obligationId = event.obligationId;
        break;
      case 'decision.clarification_requested':
      case 'decision.no_action':
        break;
      default: {
        const never: never = event;
        void never;
      }
    }

    return {
      id: event.id,
      kind: event.kind,
      timestamp: event.timestamp,
      turnId: event.turnId,
      customerId,
      obligationId,
      summary: summarizeEvent(event, snapshot),
    };
  });
}

export function buildTemporalHints(clock: ReferenceClock): AdvancedContextPackage['temporalHints'] {
  const reference = new Date(clock.referenceNow);
  return {
    today: formatDay(reference, clock.timezone),
    yesterday: formatDay(shiftDays(reference, -1), clock.timezone),
    tomorrow: formatDay(shiftDays(reference, 1), clock.timezone),
    nextFriday: nextWeekday(reference, clock.timezone, 'Friday'),
    nextMonday: nextWeekday(reference, clock.timezone, 'Monday'),
  };
}

export function buildAdvancedContextPackage(input: {
  snapshot: LedgerSnapshot;
  document: LedgerDocument;
  recentTurns: Array<{
    turnId: string;
    text: string;
  }>;
  utterance: string;
  language: string;
  clock: ReferenceClock;
}): AdvancedContextPackage {
  const resolutionCandidates = buildResolutionCandidates(input);

  return {
    clock: input.clock,
    referenceDate: formatDay(new Date(input.clock.referenceNow), input.clock.timezone),
    referenceWeekday: formatWeekday(new Date(input.clock.referenceNow), input.clock.timezone),
    temporalHints: buildTemporalHints(input.clock),
    ...resolutionCandidates,
  };
}

export function buildBaselineContextPackage(input: {
  utterance: string;
  language: string;
  clock: ReferenceClock;
}): BaselineContextPackage {
  return {
    clock: input.clock,
    currentUtterance: input.utterance,
    language: input.language,
  };
}

function recentTextsHasReference(recentTexts: string[]): boolean {
  return recentTexts.some((text) =>
    /\b(remaining|balance|that money|the one|first one|last week|earlier|settle|correction|wasn't|rather|na )\b/i.test(
      text,
    ),
  );
}
