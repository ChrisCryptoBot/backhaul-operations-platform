/** Display helpers for the dispatcher desk. Pure. */
import { percentText } from "./pay";
import { activeTz, zoneAbbr } from "./tz";

/** The one minus on the desk is the real one (U+2212), so a column of figures lines up and a loss cannot be mistaken for a dash. */
const MINUS = "−";

/** Dollars. A figure that is not known is a dash (never 0, never a guess); a loss carries a real minus. Cents where money is owed, whole dollars where it is summarised. */
export const usd = (n: number | null | undefined, digits = 0): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const text = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
  // A negative that rounds to nothing is not a loss: no minus on "$0".
  return n < 0 && /[1-9]/.test(text) ? MINUS + text : text;
};

export const perMile = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const text = Math.abs(n).toFixed(2);
  return `${n < 0 && /[1-9]/.test(text) ? MINUS : ""}$${text}/mi`;
};

/** A length in feet: "53 ft", "48.5 ft". Not known is a dash, never 0. */
export const feet = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) || n <= 0 ? "\u2014" : `${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} ft`);

export const miles = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : `${Math.round(n).toLocaleString("en-US")} mi`);

/**
 * A price a gallon: two places for a posted price, three where cents of discount matter (a card's discount a gallon, an average after discount). A price that is not known is a dash, a
 * negative (a credit) carries the real minus, and there is no "/gal" on it: the column says what it is.
 */
export const perGallon = (n: number | null | undefined, digits: 2 | 3 = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const text = Math.abs(n).toFixed(digits);
  return `${n < 0 && /[1-9]/.test(text) ? MINUS : ""}$${text}`;
};

/** Gallons, to a tenth. Not known is a dash, never 0. */
export const gallons = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 }));

export const pct = (fraction: number | null | undefined, digits = 0): string =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${(fraction * 100).toFixed(digits)}%`;

export const signedPct = (fraction: number | null | undefined): string =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;

/**
 * Every time on the desk is shown on the carrier's own clock (src/lib/tz.ts: the workspace's zone, Eastern, Central, Mountain or Pacific) and says which, "9:30 AM ET". A stop's
 * appointment is the other clock: `stopTime` shows it where the dock is, with the carrier's clock beside it when the two differ.
 */
export function shortDate(d: Date | string | null | undefined, tz: string = activeTz()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

/** "Oct 12, 2026": a day with its year, for lists that reach back more than a year. */
export function dayYear(d: Date | string | null | undefined, tz: string = activeTz()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz });
}

export function dateTime(d: Date | string | null | undefined, tz: string = activeTz()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }) + " " + zoneAbbr(tz);
}

/**
 * A stop's appointment time, read on the clock at the stop: "Nov 2, 5:24 PM CT". When the stop's zone is not the carrier's, the carrier's clock follows in brackets, "Nov 2, 6:24 PM ET
 * (5:24 PM CT)", so a dispatcher in Boston sees both the dock's time and their own. `stopZone` is worked out on the server from the stop's coordinates or state.
 */
export function stopTime(d: Date | string | null | undefined, stopZone: string | null | undefined, tz: string = activeTz()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const zone = stopZone || tz;
  const there = date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone }) + " " + zoneAbbr(zone);
  if (zone === tz) return there;
  const mine = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  return `${there} (${mine} ${zoneAbbr(tz)})`;
}

/**
 * The time of day at a stop, with no date, for a cell that already sits on a day: "6:00 AM ET (5:00 AM CT)" when the dock is not on the carrier's clock, and just "5:00 AM" when it is
 * (the day column already says which clock). The same rule as `stopTime`, so the board, the planner and the drawer read alike.
 */
export function stopClock(d: Date | number | string | null | undefined, stopZone: string | null | undefined, tz: string = activeTz()): string {
  if (d == null || d === "") return "—";
  const date = d instanceof Date ? d : new Date(d);
  const zone = stopZone || tz;
  const at = (z: string) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: z });
  return zone === tz ? at(tz) : `${at(zone)} ${zoneAbbr(zone)} (${at(tz)} ${zoneAbbr(tz)})`;
}

export type Verdict = "accept" | "caution" | "reject" | "needs_fuel";
export const VERDICT: Record<Verdict, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  accept: { label: "Covers your cost", tone: "ok" },
  caution: { label: "Thin margin", tone: "warn" },
  reject: { label: "Below your cost", tone: "bad" },
  needs_fuel: { label: "Needs a fuel price", tone: "muted" }
};

/** Tones: gold asks the dispatcher to act, green is settled, steel is moving, amber is waiting on someone, red is wrong, grey is closed. */
export type Tone = "ok" | "warn" | "bad" | "info" | "gold" | "muted";

export const LOAD_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Needs a driver", tone: "gold" },
  accepted: { label: "Accepted", tone: "ok" },
  in_progress: { label: "On the road", tone: "info" },
  completed: { label: "Delivered", tone: "ok" },
  tonu: { label: "TONU", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "bad" }
};

export const ASSIGNMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Assigned, not sent", tone: "gold" },
  dispatched: { label: "Sent, waiting", tone: "warn" },
  accepted: { label: "Driver accepted", tone: "ok" },
  declined: { label: "Driver declined", tone: "bad" },
  in_progress: { label: "On the road", tone: "info" },
  completed: { label: "Delivered", tone: "ok" }
};

export const PAY_KIND_LABEL: Record<string, string> = { flat: "Set amount", cpm: "Per mile", hourly: "Hourly", percent: "Percent of the rate" };

/** "$0.65 a mile", "$22 an hour", "$450 a load", "25% of the rate"; a dash when no pay is set. */
export function payLabel(kind: string | null | undefined, rate: number | null | undefined): string {
  if (!kind || rate == null) return "—";
  if (kind === "percent") return percentText(rate);
  const money = kind === "cpm" ? rate.toFixed(2) : Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
  return `$${money} ${kind === "cpm" ? "a mile" : kind === "hourly" ? "an hour" : "a load"}`;
}
