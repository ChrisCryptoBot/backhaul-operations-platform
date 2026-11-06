import { durationText, sittingText } from "./telematics";

/**
 * The history of a truck or a trailer as one list, newest first: where it stood and for how long, the check calls made about it, the stops it reached for its loads and who drove them, and (for a trailer)
 * which tractor pulled it and where it was left. Pure: the server reads the rows and hands them over, the times are formatted by a function the caller passes (the carrier's or the dock's clock),
 * so nothing here reads a clock or a time zone. Display only: no figure, ranking or verdict reads it.
 */
export type HistoryKind = "stay" | "call" | "arrival" | "load" | "hooked" | "dropped";

export type HistoryEntry = {
  key: string;
  kind: HistoryKind;
  /** When it began (or happened), in milliseconds. */
  at: number;
  /** When it ended, for a stay or a sitting trailer; the last time it was seen, for one still going. */
  until: number | null;
  ongoing: boolean;
  title: string;
  detail: string | null;
  meta: string | null;
  href: string | null;
};

export const CALL_STATUSES = [
  { key: "on_time", label: "On time" },
  { key: "late", label: "Running late" },
  { key: "issue", label: "Issue" }
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number]["key"];
export const callStatusOf = (v: unknown): CallStatus | null => (CALL_STATUSES.some((s) => s.key === v) ? (v as CallStatus) : null);
const statusWord = (v: string | null): string | null => CALL_STATUSES.find((s) => s.key === v)?.label ?? null;

const minutes = (from: number, to: number): number => Math.max(0, (to - from) / 60_000);
const joined = (parts: Array<string | null | undefined>, sep = " · "): string | null => {
  const p = parts.filter((x): x is string => Boolean(x && x.trim()));
  return p.length ? p.join(sep) : null;
};

/**
 * A stretch where a tractor stood in one place: "Stopped · Acme Foods dock, Memphis, TN", "3h 14m so far" while it is still there. It runs from the first fix that put it there to the last one that
 * did, never to the fix that showed it gone: the time is only what a position fix supports, so it can only understate (by up to one reading), never overstate.
 */
export function stayEntry(s: { id: string; arrivedAt: number; lastSeenAt: number; leftAt: number | null }, place: string): HistoryEntry {
  const ongoing = s.leftAt == null;
  const until = s.lastSeenAt;
  return { key: `stay:${s.id}`, kind: "stay", at: s.arrivedAt, until, ongoing, title: `Stopped · ${place}`, detail: `${durationText(minutes(s.arrivedAt, until))}${ongoing ? " so far" : ""}`, meta: null, href: null };
}

/** A check call: what the driver said, when they expect to arrive, and who took the call. `fmt` writes a time in the clock the screen uses. */
export function callEntry(c: { id: string; at: number; place: string | null; etaAt: number | null; status: string | null; note: string | null; spokeWith: string | null; loggedBy: string; loadNumber: string | null }, fmt: (ms: number) => string): HistoryEntry {
  const word = statusWord(c.status);
  return {
    key: `call:${c.id}`,
    kind: "call",
    at: c.at,
    until: null,
    ongoing: false,
    title: word ? `Check call · ${word}` : "Check call",
    detail: joined([c.place ? `Said: ${c.place}` : null, c.etaAt != null ? `ETA ${fmt(c.etaAt)}` : null, c.note]),
    meta: joined([c.spokeWith ? `Spoke with ${c.spokeWith}` : null, `Logged by ${c.loggedBy}`, c.loadNumber ? `Load ${c.loadNumber}` : null]),
    href: null
  };
}

/** A trailer hooked to a tractor or dropped. A drop reads how long it then sat (to the next hook, or to now while it still sits). */
export function moveEntry(m: { id: string; kind: "hooked" | "dropped"; at: number; tractor: string | null; /** Set on a tractor's own history: the trailer it picked up or left. */ trailer?: string | null; place: string | null; by: string }, sat: { until: number; ongoing: boolean } | null): HistoryEntry {
  if (m.kind === "hooked") return { key: `move:${m.id}`, kind: "hooked", at: m.at, until: null, ongoing: false, title: m.trailer ? `Hooked ${m.trailer}` : `Hooked to ${m.tractor ?? "a tractor"}`, detail: m.place ? `At ${m.place}` : null, meta: `By ${m.by}`, href: null };
  return {
    key: `move:${m.id}`,
    kind: "dropped",
    at: m.at,
    until: sat?.until ?? null,
    ongoing: sat?.ongoing ?? false,
    title: m.trailer ? `Dropped ${m.trailer}` : m.tractor ? `Dropped by ${m.tractor}` : "Dropped",
    detail: joined([m.place ? `At ${m.place}` : null, sat ? `${sat.ongoing ? "Sitting" : "Sat"} ${sittingText(minutes(m.at, sat.until) / 60)}` : null]),
    meta: `By ${m.by}`,
    href: null
  };
}

/** A stop reached for a load: where, which stop it was, which load, and who drove. */
export function arrivalEntry(a: { id: string; at: number; role: string | null; place: string; loadId: string; loadNumber: string | null; driver: string | null }): HistoryEntry {
  return { key: `arrive:${a.id}`, kind: "arrival", at: a.at, until: null, ongoing: false, title: `Arrived · ${a.place}`, detail: joined([a.role ? `${a.role === "delivery" ? "Delivery" : a.role === "pickup" ? "Pickup" : "Stop"}` : null, a.loadNumber ? `Load ${a.loadNumber}` : null]), meta: a.driver ? `Driver ${a.driver}` : null, href: `/loads/${a.loadId}` };
}

/** A load on the unit that has not reached a stop yet (or whose stops have no arrival typed): it is still part of where the unit has been assigned. */
export function loadEntry(l: { id: string; at: number; loadNumber: string | null; route: string; status: string; driver: string | null }): HistoryEntry {
  return { key: `load:${l.id}`, kind: "load", at: l.at, until: null, ongoing: false, title: `Load ${l.loadNumber ?? ""}`.trim(), detail: joined([l.route, l.status]), meta: l.driver ? `Driver ${l.driver}` : null, href: `/loads/${l.id}` };
}

const ORDER: Record<HistoryKind, number> = { call: 0, arrival: 1, dropped: 2, hooked: 3, stay: 4, load: 5 };

/** Newest first; at the same instant a call comes before an arrival before a stay, so the order is the same on every screen. */
export function sortHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.at - a.at || ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key));
}

/** The entries grouped by the day they began, newest day first, each day's entries newest first. `dayOf` names a day on the screen's clock ("Nov 5, 2026"). */
export function byDay(entries: readonly HistoryEntry[], dayOf: (ms: number) => string): Array<{ day: string; entries: HistoryEntry[] }> {
  const out: Array<{ day: string; entries: HistoryEntry[] }> = [];
  for (const e of sortHistory(entries)) {
    const day = dayOf(e.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

export const HISTORY_RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" }
] as const;
export const DEFAULT_HISTORY_DAYS = 30;
export const historyDays = (v: unknown): number => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return HISTORY_RANGES.some((r) => r.days === n) ? n : DEFAULT_HISTORY_DAYS;
};
