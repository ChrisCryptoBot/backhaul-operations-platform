import { calendarDaysBetween } from "@/truelane/lib/domain/calendarDays";
import { agingDueAtMs } from "@/truelane/lib/invoice";

/**
 * When an invoice is due and whether it is late: one rule, TrueLane's own, used by the header count, the invoices lists, the load page, the alerts, the exports and the reminder.
 * Due is the invoice date plus its terms in calendar days (a Net 30 sent late in the evening is not due a day early across a change of clocks), and an invoice is late from the day
 * after it is due, not the hour after. An invoice with no terms is due the day it was sent.
 */
export const dueAt = (invoicedAt: Date | null, terms: number | null): Date | null => {
  const ms = invoicedAt ? agingDueAtMs(invoicedAt.getTime(), terms) : null;
  return ms == null ? null : new Date(ms);
};

/** Calendar days past due: positive when late, zero on the due day, negative before it. Null when there is no invoice date. */
export const daysPastDue = (invoicedAt: Date | null, terms: number | null, now: Date = new Date()): number | null => {
  const due = dueAt(invoicedAt, terms);
  return due ? calendarDaysBetween(due.getTime(), now.getTime()) : null;
};

export const isOverdue = (invoicedAt: Date | null, terms: number | null, now: Date = new Date()): boolean => (daysPastDue(invoicedAt, terms, now) ?? 0) > 0;
