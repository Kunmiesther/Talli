export const NGN_MINOR_UNITS_PER_NAIRA = 100;

export function nairaToMinorUnits(naira: number): number {
  if (!Number.isInteger(naira)) {
    throw new Error(`Expected integer naira amount, received ${naira}`);
  }

  return naira * NGN_MINOR_UNITS_PER_NAIRA;
}

export function minorUnitsToNaira(minorUnits: number): number {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(`Expected integer minor units, received ${minorUnits}`);
  }

  return minorUnits / NGN_MINOR_UNITS_PER_NAIRA;
}

export function formatNgn(minorUnits: number): string {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(`Expected integer minor units, received ${minorUnits}`);
  }

  const naira = minorUnits / NGN_MINOR_UNITS_PER_NAIRA;
  return `₦${naira.toLocaleString('en-NG')}`;
}
