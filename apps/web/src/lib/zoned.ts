import { DEFAULT_TZ, activeTz } from "./tz";

/**
 * Calendar maths on a clock. By default the clock is the carrier's own (src/lib/tz.ts: the workspace's zone as this request sees it), so "this month" starts at midnight on the carrier's
 * wall clock, not UTC: a load delivered at 8 pm on the 30th is still that month's, in Dallas or in Boston. Pass `tz` to read another clock (a stop's, or the workspace's own zone when
 * the server counts money and must not trust a cookie). Pure; daylight saving is handled by asking Intl for the offset.
 *
 * The names say "central" because the desk began on one clock; they mean "the clock in `tz`" and are kept so every caller reads as before. `DESK_TZ` is the default zone, kept for the same reason.
 */
export const DESK_TZ = DEFAULT_TZ;

const clocks = new Map<string, Intl.DateTimeFormat>();
function clockOf(tz: string): Intl.DateTimeFormat {
  let c = clocks.get(tz);
  if (!c) {
    c = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    clocks.set(tz, c);
  }
  return c;
}

export type CentralParts = { y: number; m0: number; d: number; h: number; min: number; s: number };

/** The date and time an instant shows on the clock in `tz`. `m0` is the month from 0. */
export function centralParts(ms: number, tz: string = activeTz()): CentralParts {
  const p: Record<string, number> = {};
  for (const part of clockOf(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number.parseInt(part.value, 10);
  return { y: p.year!, m0: p.month! - 1, d: p.day!, h: p.hour!, min: p.minute!, s: p.second! };
}

/** Milliseconds the clock in `tz` is ahead of UTC at that instant (negative west of Greenwich: -5 h Central in summer, -6 h in winter). */
function offsetMs(ms: number, tz: string): number {
  const p = centralParts(ms, tz);
  return Date.UTC(p.y, p.m0, p.d, p.h, p.min, p.s) - (ms - (ms % 1000));
}

/** The instant the clock in `tz` reads 00:00 on that date. Months and days may overflow (m0 = 12 is January next year). */
export function centralMidnight(y: number, m0: number, d: number, tz: string = activeTz()): number {
  return centralInstant(y, m0, d, 0, 0, tz);
}

/** The instant the clock in `tz` reads the given date and time. Used to read a form's "2026-10-30 08:00" as that clock's time wherever the server runs. */
export function centralInstant(y: number, m0: number, d: number, h: number, min: number, tz: string = activeTz()): number {
  const wall = Date.UTC(y, m0, d, h, min);
  let t = wall - offsetMs(wall, tz);
  const check = wall - offsetMs(t, tz);
  if (check !== t) t = check;
  return t;
}

/** "2026-10-30T08:00" (what a datetime-local field sends) as an instant on the clock in `tz`, or null if it is not that shape or not a real date. */
export function parseCentralLocal(text: string, tz: string = activeTz()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map((x) => Number.parseInt(x, 10)) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const t = centralInstant(y, mo - 1, d, h, mi, tz);
  const back = centralParts(t, tz);
  return back.y === y && back.m0 === mo - 1 && back.d === d ? t : null; // rejects 31 Feb and the like
}

/** An instant as the "2026-10-30T08:00" a datetime-local field takes, on the clock in `tz`. */
export function toCentralLocal(ms: number, tz: string = activeTz()): string {
  const p = centralParts(ms, tz);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${two(p.m0 + 1)}-${two(p.d)}T${two(p.h)}:${two(p.min)}`;
}
