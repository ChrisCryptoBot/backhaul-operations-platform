import { centralMidnight, centralParts } from "./zoned";
import { activeTz } from "./tz";

/**
 * The periods the KPI dashboard offers, and the equivalent period before each one to compare against.
 * Windows are closed on both ends and measured in milliseconds; a load belongs to the window its finish time falls in.
 */
export type KpiPeriod = "4w" | "month" | "ytd" | "all";

export const KPI_PERIODS: Array<{ key: KpiPeriod; label: string }> = [
  { key: "4w", label: "Last 4 weeks" },
  { key: "month", label: "This month" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" }
];

export function asKpiPeriod(v: string | null | undefined): KpiPeriod {
  return KPI_PERIODS.find((p) => p.key === v)?.key ?? "4w";
}

export type TimeWindow = { start: number | null; end: number };

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export function inWindow(t: number, w: TimeWindow): boolean {
  return (w.start == null || t >= w.start) && t <= w.end;
}

/** `tz` is the clock the period is counted on. The server passes the workspace's own zone when it adds up money; left out, it is the request's display zone (src/lib/tz.ts). */
export function periodWindow(period: KpiPeriod, now: number, tz: string = activeTz()): TimeWindow {
  const p = centralParts(now, tz);
  switch (period) {
    case "4w":
      return { start: now - 4 * WEEK_MS, end: now };
    case "month":
      return { start: centralMidnight(p.y, p.m0, 1, tz), end: now };
    case "ytd":
      return { start: centralMidnight(p.y, 0, 1, tz), end: now };
    default:
      return { start: null, end: now };
  }
}

/**
 * The same stretch one period earlier: the four weeks before, the first N days of last month, the same dates last year.
 * Comparing a part-month to a whole month would flatter or punish the current one, so the lengths match. "All time" has none.
 */
export function previousWindow(period: KpiPeriod, now: number, tz: string = activeTz()): TimeWindow | null {
  const p = centralParts(now, tz);
  const cur = periodWindow(period, now, tz);
  if (period === "all" || cur.start == null) return null;
  if (period === "4w") return { start: cur.start - 4 * WEEK_MS, end: cur.start - 1 };
  if (period === "month") {
    const start = centralMidnight(p.y, p.m0 - 1, 1, tz);
    return { start, end: Math.min(start + (now - cur.start), cur.start - 1) };
  }
  const start = centralMidnight(p.y - 1, 0, 1, tz);
  const sameDate = centralMidnight(p.y - 1, p.m0, p.d, tz) + (now - centralMidnight(p.y, p.m0, p.d, tz));
  return { start, end: Math.min(sameDate, cur.start - 1) };
}

const day = (ms: number, withYear = false, tz: string = activeTz()) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: withYear ? "numeric" : undefined, timeZone: tz });

/**
 * "Oct 1 to Oct 28". When the window is not in the current year (last year's year to date) both ends carry the year, so two
 * windows with the same dates can be told apart. `ref` is the moment "now" means; it defaults to the real clock.
 */
export function windowLabel(w: TimeWindow | null, ref: number = Date.now()): string {
  if (!w) return "";
  if (w.start == null) return `Everything up to ${day(w.end, true)}`;
  const withYear = centralParts(w.end).y !== centralParts(ref).y;
  return `${day(w.start, withYear)} to ${day(w.end, withYear)}`;
}

/** Twelve trailing seven-day buckets ending now, oldest first, for the trends. */
export function weekBuckets(now: number, count = 12, tz: string = activeTz()): Array<{ start: number; end: number; label: string }> {
  return Array.from({ length: count }, (_, i) => {
    const end = now - (count - 1 - i) * WEEK_MS;
    return { start: end - WEEK_MS, end, label: day(end, false, tz) };
  });
}
