import { boardSearchText, type BoardFilterable } from "./board-filter";
import { DESK_TZ } from "./zoned";

/**
 * The Loads screen's two views. Open is the live board: loads that still need a driver, a confirmation or a trip. History is what has finished:
 * delivered, cancelled or paid a TONU. History can be narrowed to what is still owed or what fell through, sorted, and is grouped by month so a
 * year of freight reads as a year. Pure, so the page and its tests share one definition.
 */
export const OPEN_STATUSES = ["draft", "accepted", "in_progress"] as const;
export const HISTORY_STATUSES = ["completed", "cancelled", "tonu"] as const;

export const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);
export const isHistory = (status: string) => (HISTORY_STATUSES as readonly string[]).includes(status);

export const HISTORY_FILTERS = [
  { key: "all", label: "All" },
  { key: "owed", label: "Owed" },
  { key: "cancelled", label: "Cancelled" }
] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number]["key"];

export const HISTORY_SORTS = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "pay", label: "Pay" },
  { key: "permile", label: "$ per mile" }
] as const;
export type HistorySort = (typeof HISTORY_SORTS)[number]["key"];

export const asHistoryFilter = (v: string | undefined): HistoryFilter => (HISTORY_FILTERS.some((f) => f.key === v) ? (v as HistoryFilter) : "all");
export const asHistorySort = (v: string | undefined): HistorySort => (HISTORY_SORTS.some((s) => s.key === v) ? (v as HistorySort) : "newest");

export type HistoryRow = BoardFilterable & {
  id: string;
  paymentStatus: string | null;
  quotedRevenue: number;
  perMile: number | null;
  scheduledDate: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  invoicedAt: Date | null;
  paidAt: Date | null;
  invoicedAmount: number | null;
  paidAmount: number | null;
};

/** Delivered and not yet paid: nothing sent, or sent and waiting. */
export const isOwed = (r: Pick<HistoryRow, "status" | "paymentStatus">) => r.status === "completed" && r.paymentStatus !== "paid";
export const fellThrough = (r: Pick<HistoryRow, "status">) => r.status === "cancelled" || r.status === "tonu";

/** When a finished load is dated: the day it was delivered, or the day it fell through. */
export const historyDate = (r: Pick<HistoryRow, "completedAt" | "cancelledAt" | "scheduledDate">): Date | null => r.completedAt ?? r.cancelledAt ?? r.scheduledDate;

const time = (d: Date | null) => (d ? d.getTime() : 0);

export function historyRows<T extends HistoryRow>(rows: T[], f: { filter?: string; sort?: string; q?: string }): T[] {
  const filter = asHistoryFilter(f.filter);
  const sort = asHistorySort(f.sort);
  const needle = f.q?.trim().toLowerCase();
  const kept = rows
    .filter((r) => isHistory(r.status))
    .filter((r) => (filter === "owed" ? isOwed(r) : filter === "cancelled" ? fellThrough(r) : true))
    .filter((r) => !needle || boardSearchText(r).toLowerCase().includes(needle));
  const byDate = (a: T, b: T) => time(historyDate(b)) - time(historyDate(a));
  const sorted = [...kept];
  if (sort === "oldest") sorted.sort((a, b) => -byDate(a, b));
  else if (sort === "pay") sorted.sort((a, b) => b.quotedRevenue - a.quotedRevenue || byDate(a, b));
  else if (sort === "permile") sorted.sort((a, b) => (b.perMile ?? -Infinity) - (a.perMile ?? -Infinity) || byDate(a, b));
  else sorted.sort(byDate);
  return sorted;
}

const monthKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: DESK_TZ, year: "numeric", month: "2-digit" }).format(d);
const monthLabel = (d: Date) => d.toLocaleDateString("en-US", { timeZone: DESK_TZ, month: "long", year: "numeric" });

/** Consecutive rows that fall in the same month on the Dallas calendar, in the order given. A row without a date goes under "Undated". */
export function monthGroups<T extends HistoryRow>(rows: T[]): Array<{ key: string; label: string; rows: T[] }> {
  const groups: Array<{ key: string; label: string; rows: T[] }> = [];
  for (const r of rows) {
    const d = historyDate(r);
    const key = d ? monthKey(d) : "undated";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else groups.push({ key, label: d ? monthLabel(d) : "Undated", rows: [r] });
  }
  return groups;
}

export type PayRecord = { broker: string; loads: number; invoices: number; paid: number; shortPaid: number; averageDaysToPay: number | null; outstanding: number; fellThrough: number };

/** How one broker has treated the desk, from the finished loads in view. Null when the rows are not all one broker. */
export function payRecord(rows: HistoryRow[]): PayRecord | null {
  const brokers = new Set(rows.map((r) => (r.brokerName ?? "").trim().toLowerCase()));
  if (rows.length === 0 || brokers.size !== 1 || brokers.has("")) return null;
  const paid = rows.filter((r) => r.paymentStatus === "paid");
  const days = paid.filter((r) => r.invoicedAt && r.paidAt).map((r) => (time(r.paidAt) - time(r.invoicedAt)) / 86_400_000);
  const billed = (r: HistoryRow) => r.invoicedAmount ?? r.quotedRevenue;
  return {
    broker: rows[0]!.brokerName!.trim(),
    loads: rows.length,
    invoices: rows.filter((r) => r.paymentStatus != null).length,
    paid: paid.length,
    shortPaid: paid.filter((r) => r.paidAmount != null && r.paidAmount < billed(r) - 0.005).length,
    averageDaysToPay: days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : null,
    outstanding: rows.filter((r) => r.paymentStatus === "invoiced").reduce((s, r) => s + billed(r), 0),
    fellThrough: rows.filter(fellThrough).length
  };
}
