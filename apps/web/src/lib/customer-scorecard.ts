/**
 * How a customer has treated the desk on the loads that were invoiced: how often it paid inside its terms, how often it paid less than the
 * invoice, and what is still out. Pure: it is given the customer's loads and the day, and returns numbers. The terms are the load's own, else
 * the fallback the caller names (the customer's default, else the desk's).
 */
export type CustomerLoad = {
  paymentStatus: string | null;
  invoicedAt: Date | null;
  paidAt: Date | null;
  payTermsDays: number | null;
  invoicedAmount: number | null;
  paidAmount: number | null;
};

export type CustomerScorecard = {
  paid: number;
  paidWithinTerms: number;
  /** Paid loads that were paid inside their terms, 0 to 1; null with no paid load. */
  paidOnTimeRate: number | null;
  shortPaid: { loads: number; dollars: number };
  outstanding: { count: number; total: number; overdue: number; oldestDaysOverdue: number | null };
};

const DAY = 86_400_000;
const cents = (n: number) => Math.round(n * 100) / 100;

export function customerScorecard(loads: CustomerLoad[], now: Date, fallbackTerms: number): CustomerScorecard {
  let paid = 0;
  let within = 0;
  let shortLoads = 0;
  let shortDollars = 0;
  let count = 0;
  let total = 0;
  let overdue = 0;
  let oldest: number | null = null;
  for (const l of loads) {
    const terms = l.payTermsDays ?? fallbackTerms;
    if (l.paymentStatus === "paid" && l.invoicedAt && l.paidAt) {
      paid += 1;
      // Calendar days from the invoice to the payment: paying on the due day is inside the terms.
      if (Math.floor((l.paidAt.getTime() - l.invoicedAt.getTime()) / DAY) <= terms) within += 1;
      if (l.paidAmount != null && l.invoicedAmount != null && l.paidAmount < l.invoicedAmount - 0.005) {
        shortLoads += 1;
        shortDollars += l.invoicedAmount - l.paidAmount;
      }
    }
    if (l.paymentStatus === "invoiced" && l.invoicedAt) {
      count += 1;
      total += l.invoicedAmount ?? 0;
      const late = Math.floor((now.getTime() - (l.invoicedAt.getTime() + terms * DAY)) / DAY);
      if (late > 0) {
        overdue += 1;
        oldest = Math.max(oldest ?? 0, late);
      }
    }
  }
  return { paid, paidWithinTerms: within, paidOnTimeRate: paid > 0 ? within / paid : null, shortPaid: { loads: shortLoads, dollars: cents(shortDollars) }, outstanding: { count, total: cents(total), overdue, oldestDaysOverdue: oldest } };
}
