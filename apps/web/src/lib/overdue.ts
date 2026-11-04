import { parseCentralLocal, toCentralLocal } from "./zoned";

/**
 * When an invoice is due and whether it is late: one rule, used by the header count, the invoices lists, the load page, the alerts, the exports and the reminder. Everything is read on
 * the desk's own calendar (Dallas), never the server's: a host in another zone (a UTC server) would otherwise call an invoice late in the evening of its due day.
 * Due is the invoice date plus its terms in calendar days, at the same clock time (a Net 30 sent late in the evening is not due a day early across a change of clocks), and an invoice
 * is late from the day after it is due, not the hour after. An invoice with no terms is due the day it was sent; terms of 0 are "due on receipt".
 */
const DAY_MS = 86_400_000;
/** "2026-10-31T17:00" read as a calendar date only, as a UTC day number. */
const dayNumber = (local: string): number => Date.UTC(Number(local.slice(0, 4)), Number(local.slice(5, 7)) - 1, Number(local.slice(8, 10))) / DAY_MS;

/** Whole calendar days on the desk's calendar from one moment to a later one (negative when it is earlier). */
export const deskDaysBetween = (from: Date, to: Date): number => Math.round(dayNumber(toCentralLocal(to.getTime())) - dayNumber(toCentralLocal(from.getTime())));

export const dueAt = (invoicedAt: Date | null, terms: number | null): Date | null => {
  if (!invoicedAt || !Number.isFinite(invoicedAt.getTime())) return null;
  const local = toCentralLocal(invoicedAt.getTime());
  const days = terms != null && Number.isFinite(terms) ? terms : 0;
  const due = new Date(dayNumber(local) * DAY_MS + days * DAY_MS);
  const ms = parseCentralLocal(`${due.toISOString().slice(0, 10)}T${local.slice(11, 16)}`);
  return ms == null ? null : new Date(ms);
};

/** Calendar days past due on the desk's calendar: positive when late, zero on the due day, negative before it. Null when there is no invoice date. */
export const daysPastDue = (invoicedAt: Date | null, terms: number | null, now: Date = new Date()): number | null => {
  const due = dueAt(invoicedAt, terms);
  if (!due) return null;
  return deskDaysBetween(due, now);
};

export const isOverdue = (invoicedAt: Date | null, terms: number | null, now: Date = new Date()): boolean => (daysPastDue(invoicedAt, terms, now) ?? 0) > 0;
