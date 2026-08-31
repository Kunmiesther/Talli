import type { LedgerSnapshot } from '../domain/ledger.js';
import { type LedgerIntent, ledgerIntentSchema } from '../llm/intent.js';

export interface ExplicitLedgerIntentResult {
  intent: LedgerIntent;
  explicitCurrency: string | null;
}

const CUSTOMER_VERB_PATTERN =
  /^(?:actually|correction|no|wait|sorry|please|uh|um|well|okay|ok|right|so|then|now|i mean|what i meant was|instead of|instead)?\s*(?<customer>[\p{L}][\p{L}'-]*(?:\s+(?!has\b|have\b|had\b|is\b|was\b|were\b|am\b|are\b)[\p{L}][\p{L}'-]*){0,2})\s+(?:(?:has|have|had|is|was|were|am|are)\s+)?(?<verb>owes(?:\s+me)?|owed|is\s+owing(?:\s+me)?|owing(?:\s+me)?|paid(?:\s+back|\s+off)?|repaid|brought|gave|returned|settled|cleared|took|borrowed|bought(?:\s+on\s+credit)?|collected|will\s+pay|pay|pays)\b/iu;

const MONEY_PATTERN =
  /(?<symbol>[$\u00A3\u20AC\u20A6])?\s*(?<amount>\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)(?:\s*(?<multiplier>k|thousand|m|million))?(?:\s*(?<currency>dollars?|usd|naira|ngn|pounds?|gbp|euros?|eur))?/iu;

function titleCaseName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (!part) {
        return part;
      }
      return `${part[0]?.toLocaleUpperCase() ?? ''}${part.slice(1).toLocaleLowerCase()}`;
    })
    .join(' ');
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCustomerName(text: string, snapshot: LedgerSnapshot): string | null {
  const leadingMatch = text.match(CUSTOMER_VERB_PATTERN);
  if (leadingMatch?.groups?.customer) {
    return titleCaseName(leadingMatch.groups.customer);
  }

  const normalizedText = normalizeForSearch(text);
  const customers = [...snapshot.customers].sort((left, right) => {
    const leftScore = Math.max(
      left.displayName.length,
      ...left.aliases.map((alias) => alias.length),
    );
    const rightScore = Math.max(
      right.displayName.length,
      ...right.aliases.map((alias) => alias.length),
    );
    return rightScore - leftScore;
  });

  for (const customer of customers) {
    const names = [customer.displayName, ...customer.aliases];
    for (const name of names) {
      const normalizedName = normalizeForSearch(name);
      if (normalizedName && normalizedText.includes(normalizedName)) {
        return customer.displayName;
      }
    }
  }

  return null;
}

function extractMoney(
  text: string,
): { amountMinor: number; explicitCurrency: string | null } | null {
  const match = text.match(MONEY_PATTERN);
  if (!match?.groups?.amount) {
    return null;
  }

  const rawAmount = Number.parseFloat(match.groups.amount.replaceAll(',', ''));
  if (!Number.isFinite(rawAmount)) {
    return null;
  }

  const multiplier = match.groups.multiplier?.toLowerCase() ?? null;
  const scaledAmount =
    multiplier === 'k' || multiplier === 'thousand'
      ? rawAmount * 1_000
      : multiplier === 'm' || multiplier === 'million'
        ? rawAmount * 1_000_000
        : rawAmount;
  const amountMinor = Math.round(scaledAmount * 100);

  const symbol = match.groups.symbol ?? null;
  const currencyText = match.groups.currency?.toLowerCase() ?? null;
  const explicitCurrency =
    symbol === '$'
      ? 'USD'
      : symbol === '\u00A3'
        ? 'GBP'
        : symbol === '\u20AC'
          ? 'EUR'
          : symbol === '\u20A6'
            ? 'NGN'
            : currencyText?.startsWith('usd')
              ? 'USD'
              : currencyText?.startsWith('dollar')
                ? 'USD'
                : currencyText?.startsWith('naira')
                  ? 'NGN'
                  : currencyText?.startsWith('ngn')
                    ? 'NGN'
                    : currencyText?.startsWith('gbp')
                      ? 'GBP'
                      : currencyText?.startsWith('pound')
                        ? 'GBP'
                        : currencyText?.startsWith('eur')
                          ? 'EUR'
                          : currencyText?.startsWith('euro')
                            ? 'EUR'
                            : null;

  return { amountMinor, explicitCurrency };
}

function looksLikeSettlement(text: string): boolean {
  return /\b(settled|cleared|paid the rest|paid the balance|paid everything|paid in full|paid off|rest of it|remaining amount|the rest)\b/i.test(
    text,
  );
}

function looksLikeCorrection(text: string): boolean {
  return /\b(actually|correction|corrections|no,|no\.|instead|rather|not\s+\d|wasn't|was not|wrong)\b/i.test(
    text,
  );
}

function hasPaymentVerb(text: string): boolean {
  return /\b(paid(?:\s+back|\s+off)?|repaid|brought|gave|returned|sent|settled|cleared)\b/i.test(
    text,
  );
}

function hasObligationVerb(text: string): boolean {
  return /\b(owes(?:\s+me)?|owed|is\s+owing(?:\s+me)?|owing(?:\s+me)?|took|borrowed|bought(?:\s+on\s+credit)?|collected|got)\b/i.test(
    text,
  );
}

function buildIntent(
  input: { text: string },
  payload: Record<string, unknown>,
  explicitCurrency: string | null,
): ExplicitLedgerIntentResult {
  return {
    explicitCurrency,
    intent: ledgerIntentSchema.parse({
      ...payload,
      evidence: [input.text],
    }),
  };
}

export function parseExplicitLedgerIntent(input: {
  text: string;
  snapshot: LedgerSnapshot;
}): ExplicitLedgerIntentResult | null {
  const text = input.text.trim();
  if (!text) {
    return null;
  }

  const money = extractMoney(text);
  const customerName = extractCustomerName(text, input.snapshot);
  const explicitCurrency = money?.explicitCurrency ?? null;

  if (looksLikeCorrection(text)) {
    if (customerName === null || money === null) {
      return null;
    }
    return buildIntent(
      input,
      {
        intent: 'correct_obligation',
        obligation: { phrase: customerName },
        correctedAmountMinor: money.amountMinor,
        correctionReason: 'Customer corrected the original amount.',
      },
      explicitCurrency,
    );
  }

  if (looksLikeSettlement(text)) {
    if (customerName === null) {
      return null;
    }
    return buildIntent(
      input,
      {
        intent: 'settle_obligation',
        obligation: { phrase: customerName },
        settleRemaining: true,
      },
      explicitCurrency,
    );
  }

  if (hasPaymentVerb(text)) {
    if (customerName === null || money === null) {
      return null;
    }
    return buildIntent(
      input,
      {
        intent: 'record_payment',
        customer: { name: customerName },
        amountMinor: money.amountMinor,
        settleRemaining: false,
      },
      explicitCurrency,
    );
  }

  if (hasObligationVerb(text)) {
    if (customerName === null || money === null) {
      return null;
    }
    return buildIntent(
      input,
      {
        intent: 'create_obligation',
        customer: { name: customerName },
        amountMinor: money.amountMinor,
      },
      explicitCurrency,
    );
  }

  return null;
}
