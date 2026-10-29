/**
 * Calendar maths on the desk's clock. The fleet runs out of Dallas, so "this month" starts at midnight Central, not UTC
 * (a load delivered at 8 pm on the 30th is still that month's). Pure; daylight saving is handled by asking Intl for the offset.
 */
export const DESK_TZ = "America/Chicago";

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: DESK_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric"
});

export type CentralParts = { y: number; m0: number; d: number; h: number; min: number; s: number };

/** The date and time an instant shows on a Central clock. `m0` is the month from 0. */
export function centralParts(ms: number): CentralParts {
  const p: Record<string, number> = {};
  for (const part of clock.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number.parseInt(part.value, 10);
  return { y: p.year!, m0: p.month! - 1, d: p.day!, h: p.hour!, min: p.minute!, s: p.second! };
}

/** Milliseconds Central is ahead of UTC at that instant (negative: -5 h in summer, -6 h in winter). */
function offsetMs(ms: number): number {
  const p = centralParts(ms);
  return Date.UTC(p.y, p.m0, p.d, p.h, p.min, p.s) - (ms - (ms % 1000));
}

/** The instant a Central clock reads 00:00 on that date. Months and days may overflow (m0 = 12 is January next year). */
export function centralMidnight(y: number, m0: number, d: number): number {
  const wall = Date.UTC(y, m0, d);
  let t = wall - offsetMs(wall);
  const check = wall - offsetMs(t);
  if (check !== t) t = check;
  return t;
}
