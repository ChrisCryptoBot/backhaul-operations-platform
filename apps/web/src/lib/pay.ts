/**
 * How a driver can be paid, and what a percent comes to. A driver is paid per loaded mile, by the hour, a set amount for the load, or a percent
 * of what the rate confirmation pays. The percent is taken of the agreed rate plus its fuel surcharge (the rate confirmation's total), not of
 * detention, lumper or other extras the dispatcher bills on top; those can be shared with the driver as a line on their statement. Pure, so the
 * forms, the verdict, the estimate and the statement all work the same sum.
 */
export type PayKind = "flat" | "cpm" | "hourly" | "percent";
export const PAY_KIND_KEYS: readonly PayKind[] = ["cpm", "hourly", "flat", "percent"];

/** A percent pay is a share, so it is more than nothing and less than all of the rate. */
export const PERCENT_MAX = 99.99;

export const RATE_CON_BASIS = "the agreed rate plus its fuel surcharge (not detention or other extras)";

/** What a rate confirmation pays: the agreed rate plus its fuel surcharge, to the cent. */
export function rateConTotal(rate: number | null | undefined, fuelSurcharge: number | null | undefined): number {
  return (Math.round((rate ?? 0) * 100) + Math.round((fuelSurcharge ?? 0) * 100)) / 100;
}

/** A percent of an amount, to the cent (half a cent rounds up, as the database does). */
export function percentOf(percent: number, base: number): number {
  const cents = (percent * base) / 100 * 100;
  return Math.round(cents + 1e-7) / 100;
}

/** "25% of the rate": a percent as people say it (25, not 25.00). */
export const percentText = (percent: number): string => `${Number(percent.toFixed(2))}% of the rate`;
