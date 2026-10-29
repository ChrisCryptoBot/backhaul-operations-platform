// VENDORED from TrueLane lib/fuelSurcharge.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Fuel surcharge is entered as either a percent of the offer or dollars per
 * loaded mile. The DB column `fuel_surcharge` stays in dollars.
 * Those dollars are added on top of the offer for gross and pocket.
 * It is billed money, so both conversions round to the cent (V-10: 0.35 × 1,300 was 454.99999999999994).
 */

export type FuelSurchargeUnit = 'percent' | 'per_mile';

const toCents = (n: number) => Math.round(n * 100) / 100;

/** Dollar surcharge added to the offer: (percent / 100) × offer, to the cent. */
export function fuelSurchargeDollarsFromPercent(
  offerDollars: number,
  percent: number
): number {
  if (!(offerDollars > 0) || !(percent > 0) || !Number.isFinite(offerDollars) || !Number.isFinite(percent)) {
    return 0;
  }
  return toCents(offerDollars * (percent / 100));
}

/** Dollar surcharge added to the offer: dollarsPerMile × loaded miles, to the cent. */
export function fuelSurchargeDollarsFromPerMile(loadedMiles: number, dollarsPerMile: number): number {
  if (!(loadedMiles > 0) || !(dollarsPerMile > 0) || !Number.isFinite(loadedMiles) || !Number.isFinite(dollarsPerMile)) {
    return 0;
  }
  return toCents(loadedMiles * dollarsPerMile);
}

/** Percent of offer represented by stored FSC dollars. Null when not displayable. */
export function fuelSurchargePercentFromDollars(
  offerDollars: number,
  surchargeDollars: number
): number | null {
  if (
    !(offerDollars > 0) ||
    !(surchargeDollars > 0) ||
    !Number.isFinite(offerDollars) ||
    !Number.isFinite(surchargeDollars)
  ) {
    return null;
  }
  return (surchargeDollars / offerDollars) * 100;
}

/** Dollars per loaded mile represented by stored FSC dollars. Null when not displayable. */
export function fuelSurchargePerMileFromDollars(
  loadedMiles: number,
  surchargeDollars: number
): number | null {
  if (
    !(loadedMiles > 0) ||
    !(surchargeDollars > 0) ||
    !Number.isFinite(loadedMiles) ||
    !Number.isFinite(surchargeDollars)
  ) {
    return null;
  }
  return surchargeDollars / loadedMiles;
}

/** Dollars added to the offer from whichever unit the form is showing. */
export function fuelSurchargeDollars(input: {
  offerDollars: number;
  loadedMiles: number;
  amount: number;
  unit: FuelSurchargeUnit;
}): number {
  if (input.unit === 'per_mile') {
    return fuelSurchargeDollarsFromPerMile(input.loadedMiles, input.amount);
  }
  return fuelSurchargeDollarsFromPercent(input.offerDollars, input.amount);
}

export function formatFuelSurchargeAmount(amount: number | null): string {
  if (amount == null || !(amount > 0) || !Number.isFinite(amount)) return '';
  return String(parseFloat(amount.toFixed(4)));
}

/** Form string for the percent field when hydrating from stored dollars. */
export function formatFuelSurchargePercentInput(
  offerDollars: number,
  surchargeDollars: number | null | undefined
): string {
  return formatFuelSurchargeAmount(fuelSurchargePercentFromDollars(offerDollars, surchargeDollars ?? 0));
}

/** Form string for the $/mi field when hydrating from stored dollars. */
export function formatFuelSurchargePerMileInput(
  loadedMiles: number,
  surchargeDollars: number | null | undefined
): string {
  return formatFuelSurchargeAmount(fuelSurchargePerMileFromDollars(loadedMiles, surchargeDollars ?? 0));
}
