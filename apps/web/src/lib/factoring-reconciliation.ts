import { Prisma } from "@prisma/client";

/**
 * Factoring reconciliation (docs/MONEY_PLAN.md, Wave 2): every invoice that has been with a factor, with what the factor advanced, charged, held and released, what it charged back, and what
 * the customer has paid; and the totals, added up from those same rows in whole cents, so the screen's totals are the sum of the invoices it lists and nothing else. Pure.
 */
export type ReconRow = {
  invoiceId: string;
  loadId: string | null;
  number: string;
  customer: string | null;
  /** requested | submitted | funded | rejected | paid (the factoring words), and the invoice's own open | paid. */
  factoring: string;
  invoiceStatus: string;
  total: number;
  advance: number | null;
  fee: number | null;
  /** The reserve the factor held when it funded. */
  reserve: number | null;
  reserveReleased: number | null;
  chargeback: number | null;
  /** What the customer has paid on the invoice (credits not counted). */
  paidByCustomer: number;
  reference: string | null;
  updatedAt: Date | null;
};

export type ReconTotals = {
  count: number;
  /** Sent and not yet funded or rejected (requested or submitted): how many, and what they bill. */
  withFactor: { count: number; total: number };
  funded: { count: number; advances: number; fees: number };
  /** Reserve still held by the factor: funded invoices the customer has not paid yet. */
  reserveHeld: number;
  reserveReleased: number;
  chargebacks: { count: number; amount: number };
  paidByCustomers: number;
  /** Advances plus released reserve, less chargebacks: what the factor has paid the fleet, net. */
  netFromFactor: number;
};

const d = (n: number | null | undefined) => new Prisma.Decimal(n ?? 0);

export function reconcile(rows: ReconRow[]): ReconTotals {
  let withCount = 0;
  let withTotal = d(0);
  let fundedCount = 0;
  let advances = d(0);
  let fees = d(0);
  let held = d(0);
  let released = d(0);
  let cbCount = 0;
  let cb = d(0);
  let paid = d(0);
  for (const r of rows) {
    if (r.factoring === "requested" || r.factoring === "submitted") {
      withCount++;
      withTotal = withTotal.plus(r.total);
    }
    // An invoice that was funded keeps its advance in the totals whatever happened next (paid, or charged back); the chargeback is counted on its own.
    if (r.advance != null) {
      fundedCount++;
      advances = advances.plus(r.advance);
      fees = fees.plus(r.fee ?? 0);
    }
    if (r.factoring === "funded") held = held.plus(r.reserve ?? 0);
    released = released.plus(r.reserveReleased ?? 0);
    if (r.chargeback != null) {
      cbCount++;
      cb = cb.plus(r.chargeback);
    }
    paid = paid.plus(r.paidByCustomer);
  }
  const net = advances.plus(released).minus(cb);
  const n = (x: Prisma.Decimal) => x.toDecimalPlaces(2).toNumber();
  return {
    count: rows.length,
    withFactor: { count: withCount, total: n(withTotal) },
    funded: { count: fundedCount, advances: n(advances), fees: n(fees) },
    reserveHeld: n(held),
    reserveReleased: n(released),
    chargebacks: { count: cbCount, amount: n(cb) },
    paidByCustomers: n(paid),
    netFromFactor: n(net)
  };
}
