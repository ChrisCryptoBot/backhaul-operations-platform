/**
 * The rules behind the desk's date and date-and-time field (components/desk/date-input.tsx). Pure, so they can be tested.
 * A field's value is what a native date box would give: "2026-10-29" for a day, "2026-10-29T17:06" for a day and a time (24-hour, no zone: the desk reads it as Dallas time).
 */
export type Ymd = { y: number; m: number; d: number };
export type Hm = { h: number; min: number };

const two = (n: number) => String(n).padStart(2, "0");

/** A real calendar day, or null (31 February is not one). `m` counts from 1. */
export function ymd(y: number, m: number, d: number): Ymd | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  return d <= daysIn(y, m) ? { y, m, d } : null;
}

export const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "2026-10-29" or "2026-10-29T17:06" (also "…T17:06:00") as its parts; the time is null for a day alone. Null if it is not that shape or not a real day or time. */
export function parseValue(v: string | null | undefined): { day: Ymd; time: Hm | null } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/.exec((v ?? "").trim());
  if (!m) return null;
  const day = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!day) return null;
  if (m[4] == null) return { day, time: null };
  const h = Number(m[4]);
  const min = Number(m[5]);
  return h > 23 || min > 59 ? null : { day, time: { h, min } };
}

export const formatValue = (day: Ymd, time?: Hm | null): string => `${day.y}-${two(day.m)}-${two(day.d)}${time ? `T${two(time.h)}:${two(time.min)}` : ""}`;

/** What the box shows: "10/29/2026", or "10/29/2026 5:06 PM" with a time. */
export function display(v: string | null | undefined, withTime: boolean): string {
  const p = parseValue(v);
  if (!p) return "";
  const date = `${two(p.day.m)}/${two(p.day.d)}/${p.day.y}`;
  if (!withTime || !p.time) return date;
  const h12 = p.time.h % 12 === 0 ? 12 : p.time.h % 12;
  return `${date} ${h12}:${two(p.time.min)} ${p.time.h >= 12 ? "PM" : "AM"}`;
}

/**
 * What a person typed, as a field value: "10/29/2026", "10-29-26", "10/29/2026 5:06 pm", "10/29/2026 17:06". A two-digit year is 20xx. With `withTime`, a day alone gets
 * `fallback` as its time (the desk does not invent one: the caller says which). Null when it is not a real day and time.
 */
export function parseTyped(text: string, withTime: boolean, fallback: Hm): string | null {
  const m = /^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:[\sT,]+(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?m?\.?)?)?\s*$/i.exec(text);
  if (!m) return null;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const day = ymd(year, Number(m[1]), Number(m[2]));
  if (!day) return null;
  if (!withTime) return formatValue(day);
  if (m[4] == null) return formatValue(day, fallback);
  let h = Number(m[4]);
  const min = m[5] == null ? 0 : Number(m[5]);
  if (min > 59) return null;
  if (m[6]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[6].toLowerCase() === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return formatValue(day, { h, min });
}

/** The 6 weeks (42 days) that cover a month, starting on the Sunday on or before the 1st. `inMonth` is false for the days borrowed from either side. */
export function monthGrid(y: number, m: number): Array<{ day: Ymd; inMonth: boolean }> {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = Date.UTC(y, m - 1, 1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => {
    const dt = new Date(start + i * 86_400_000);
    const day = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    return { day, inMonth: day.y === y && day.m === m };
  });
}

/** A day moved by whole days (negative goes back). */
export function addDays(day: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** A day moved by whole months, the date kept where the month is long enough and clamped to its last day where not (31 Jan + 1 month is 28 or 29 Feb). */
export function addMonths(day: Ymd, n: number): Ymd {
  const idx = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(day.d, daysIn(y, m)) };
}

/** -1, 0 or 1: is a before, the same as, or after b. */
export const compareDays = (a: Ymd, b: Ymd): number => a.y - b.y || a.m - b.m || a.d - b.d;

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
