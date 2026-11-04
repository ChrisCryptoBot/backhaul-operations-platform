import { deskDaysBetween, isOverdue } from "./overdue";

/**
 * Customer payment performance summarizer (M3).
 *
 * Works out whether a customer is slow-pay or has overdue balances based on
 * internal invoicing and payment history in the desk.
 * Answers "will they pay?" right beside the Customer field before booking.
 */
export type CustomerSlowPay = {
  avgDaysToPay: number | null;
  overdueCount: number;
  overdueBalance: number;
  isSlowPay: boolean;
};

export type CustomerLoadPayRecord = {
  brokerName: string | null;
  paymentStatus: string | null;
  invoicedAt: Date | null;
  paidAt: Date | null;
  invoicedAmount: number | null;
  payTermsDays: number | null;
};

/**
 * Group loads by customer name and calculate payment history.
 * Considers a customer slow-pay if average payment time exceeds 45 days
 * or if there are any invoices currently past due.
 */
export function summarizeCustomerPay(
  records: CustomerLoadPayRecord[],
  now: Date = new Date()
): Map<string, CustomerSlowPay> {
  const map = new Map<string, { daysSum: number; paidCount: number; overdueCount: number; overdueBalance: number }>();

  for (const r of records) {
    const raw = r.brokerName?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();

    let entry = map.get(key);
    if (!entry) {
      entry = { daysSum: 0, paidCount: 0, overdueCount: 0, overdueBalance: 0 };
      map.set(key, entry);
    }

    if (r.paymentStatus === "paid" && r.invoicedAt && r.paidAt) {
      const days = deskDaysBetween(r.invoicedAt, r.paidAt);
      if (days >= 0 && days < 365) {
        entry.daysSum += days;
        entry.paidCount += 1;
      }
    } else if (r.paymentStatus === "invoiced" && r.invoicedAt) {
      if (isOverdue(r.invoicedAt, r.payTermsDays ?? 30, now)) {
        entry.overdueCount += 1;
        entry.overdueBalance += r.invoicedAmount ?? 0;
      }
    }
  }

  const out = new Map<string, CustomerSlowPay>();
  for (const [key, entry] of map.entries()) {
    const avgDaysToPay = entry.paidCount > 0 ? Math.round(entry.daysSum / entry.paidCount) : null;
    const isSlowPay = (avgDaysToPay != null && avgDaysToPay > 45) || entry.overdueCount > 0;
    out.set(key, {
      avgDaysToPay,
      overdueCount: entry.overdueCount,
      overdueBalance: entry.overdueBalance,
      isSlowPay
    });
  }

  return out;
}
