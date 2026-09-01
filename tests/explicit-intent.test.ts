import { describe, expect, it } from 'vitest';
import { parseExplicitLedgerIntent } from '../src/app/explicit-intent.js';
import { createLedgerDocument, projectLedger } from '../src/domain/ledger.js';
import { nairaToMinorUnits } from '../src/domain/money.js';

function emptySnapshot() {
  return projectLedger(createLedgerDocument('explicit-intent'));
}

describe('explicit ledger intent parsing', () => {
  it.each([
    ['John owes 100 naira', nairaToMinorUnits(100), 'NGN'],
    ['John owes 500 naira', nairaToMinorUnits(500), 'NGN'],
    ['John owes 1000 naira', nairaToMinorUnits(1_000), 'NGN'],
    ['John owes 1500 naira', nairaToMinorUnits(1_500), 'NGN'],
    ['John owes 3000 naira', nairaToMinorUnits(3_000), 'NGN'],
    ['John owes 10,000 naira', nairaToMinorUnits(10_000), 'NGN'],
    ['John owes ₦1000', nairaToMinorUnits(1_000), 'NGN'],
    ['John owes ₦1,000', nairaToMinorUnits(1_000), 'NGN'],
    ['John owes ₦3,000.00', nairaToMinorUnits(3_000), 'NGN'],
    ['John owes 100 dollars', 10_000, 'USD'],
    ['John owes 1000 dollars', 100_000, 'USD'],
  ])('parses %s as %i minor units', (text, expectedAmountMinor, expectedCurrency) => {
    const result = parseExplicitLedgerIntent({
      text,
      snapshot: emptySnapshot(),
    });

    expect(result).not.toBeNull();
    expect(result?.intent.intent).toBe('create_obligation');
    expect(result?.intent.amountMinor).toBe(expectedAmountMinor);
    expect(result?.explicitCurrency).toBe(expectedCurrency);
  });
});
