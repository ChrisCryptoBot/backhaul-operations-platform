import { Prisma } from "@prisma/client";

/**
 * What a factor pays and keeps on an invoice (docs/MONEY_PLAN.md, Wave 2). The factor advances a share of the invoice at once (the advance), holds the rest (the reserve) until the
 * customer pays, and takes its fee out of the reserve when it releases it. If the customer never pays, the factor charges the advance back (recourse). Pure, in whole cents.
 */
export type FactoringRates = { advancePct: Prisma.Decimal.Value | null; feePct: Prisma.Decimal.Value | null };
export type Economics = {
  /** Paid to the carrier when the invoice is funded. */
  advance: number;
  /** Held by the factor until the customer pays. */
  reserveHeld: number;
  /** The factor's fee, taken from the reserve when it is released. */
  fee: number;
  /** What the factor releases to the carrier once the customer has paid: the reserve less the fee, never below zero. */
  reserveReleasable: number;
  /** Everything the carrier ends up with when the customer pays in full: the advance plus the released reserve. */
  netToCarrier: number;
};

const cents = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n).toDecimalPlaces(2);

/** Null when the advance rate is not set (nothing can be worked out); a missing fee rate is a fee of zero. */
export function economicsOf(total: Prisma.Decimal.Value, rates: FactoringRates): Economics | null {
  if (rates.advancePct == null) return null;
  const t = cents(total);
  const advance = t.times(rates.advancePct).dividedBy(100).toDecimalPlaces(2);
  const reserve = t.minus(advance);
  const fee = rates.feePct == null ? new Prisma.Decimal(0) : t.times(rates.feePct).dividedBy(100).toDecimalPlaces(2);
  const left = reserve.minus(fee);
  const releasable = left.isNegative() ? new Prisma.Decimal(0) : left;
  return { advance: advance.toNumber(), reserveHeld: reserve.toNumber(), fee: fee.toNumber(), reserveReleasable: releasable.toNumber(), netToCarrier: advance.plus(releasable).toNumber() };
}

/** What the carrier owes back when the factor charges an unpaid invoice back (recourse): the advance it paid. */
export const chargebackOf = (advance: Prisma.Decimal.Value): number => cents(advance).toNumber();
