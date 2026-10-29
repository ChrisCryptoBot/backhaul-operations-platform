// VENDORED from TrueLane lib/domain/calendarDays.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Shared local-calendar day arithmetic (M-22).
 *
 * Wall-clock `diff / 86400000` disagrees with local calendar day starts near DST.
 * `daysAgo` (lastTimeOnLane) uses this helper.
 */

/** Start of the local calendar day containing `ms`. */
export function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days between two ms timestamps, computed from local-day starts.
 * Signed: positive when `laterMs` is after `earlierMs`. Callers that need a
 * non-negative "days ago" clamp with `Math.max(0, …)` (a future earlierMs → 0).
 */
export function calendarDaysBetween(earlierMs: number, laterMs: number): number {
  if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) return 0;
  return Math.round((startOfLocalDayMs(laterMs) - startOfLocalDayMs(earlierMs)) / DAY_MS);
}

/**
 * `ms` moved by whole local calendar days, same clock time. `ms + days * 86400000` lands an hour
 * off across a DST change — a Net 30 invoice sent at 12:30 AM before "fall back" came due a day early.
 */
export function addCalendarDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
