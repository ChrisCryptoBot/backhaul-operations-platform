import { centralInstant, centralParts } from "./zoned";
import { activeTz } from "./tz";

/**
 * Driver shifts: who is working when, on the carrier's clock. A weekly template (seven days, Sunday first, each a shift that STARTS that day or a day off) plus one-day exceptions (time off, or a
 * different shift for a date). A shift whose end is at or before its start runs past midnight into the next morning (22:00 to 06:00), and that tail belongs to the day the shift started: Friday
 * at 3:00 AM is inside Thursday night's shift. A driver with no schedule is neither on nor off: nothing here ever flags them. A caution, never a rule. Pure; plain data in, plain data out.
 */
export type Shift = { start: number; end: number }; // minutes from midnight; end may be 1440 (midnight); an end at or before the start is the next morning
export type Week = Array<Shift | null>; // Sunday to Saturday
export type TimeOff = { dateKey: string; kind: "off" | "shift"; start: number | null; end: number | null; note: string | null };
export type DriverSchedule = { week: Week; exceptions: TimeOff[] };

/** One stretch of work as instants. `tail` is the part of the night before's shift that runs into this day. */
export type Block = { startMs: number; endMs: number; anchor: string; tail: boolean; note: string | null };

const two = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;

// A fleet's drivers share a handful of shifts, and the planner asks the same few questions of every one of them (1,500 drivers by seven days), so the clock conversions are kept. Pure functions of
// their arguments, so a kept answer is always the same as a fresh one; the maps are emptied when they grow, so a long-running server holds a bounded few.
const KEPT_MAX = 20_000;
const keys = new Map<string, string>();
const blocks = new Map<string, { startMs: number; endMs: number }>();
const keep = <T>(m: Map<string, T>, k: string, make: () => T): T => {
  const hit = m.get(k);
  if (hit !== undefined) return hit;
  if (m.size >= KEPT_MAX) m.clear();
  const v = make();
  m.set(k, v);
  return v;
};

/** YYYY-MM-DD of the day an instant falls on, on the clock in `tz`. */
export function dateKeyOf(ms: number, tz: string = activeTz()): string {
  return keep(keys, `${tz}|${ms}`, () => {
    const p = centralParts(ms, tz);
    return `${p.y}-${two(p.m0 + 1)}-${two(p.d)}`;
  });
}

const parts = (key: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? { y: Number(m[1]), m0: Number(m[2]) - 1, d: Number(m[3]) } : null;
};

/** The key of the day `n` days from this one (negative for earlier), by calendar, so a clock change cannot slip it. */
export function addDaysKey(key: string, n: number): string {
  const p = parts(key)!;
  const d = new Date(Date.UTC(p.y, p.m0, p.d + n));
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** 0 Sunday to 6 Saturday. */
export function weekdayOf(key: string): number {
  const p = parts(key)!;
  return new Date(Date.UTC(p.y, p.m0, p.d)).getUTCDay();
}

/** A shift as instants, starting on `key`. */
export function blockOf(key: string, shift: Shift, tz: string = activeTz(), note: string | null = null): Block {
  const { startMs, endMs } = keep(blocks, `${tz}|${key}|${shift.start}|${shift.end}`, () => {
    const p = parts(key)!;
    const overnight = shift.end <= shift.start;
    return { startMs: centralInstant(p.y, p.m0, p.d, 0, shift.start, tz), endMs: centralInstant(p.y, p.m0, p.d + (overnight ? 1 : 0), 0, shift.end, tz) };
  });
  return { startMs, endMs, anchor: key, tail: false, note };
}

export type ShiftStarting = { kind: "unset" } | { kind: "off"; note: string | null } | { kind: "on"; shift: Shift; note: string | null; exception: boolean };

/** What the schedule says about the shift that starts on this date: not set, a day off (the template's or an exception's), or the shift. */
export function shiftStarting(schedule: DriverSchedule | null, key: string): ShiftStarting {
  if (!schedule) return { kind: "unset" };
  const ex = schedule.exceptions.find((e) => e.dateKey === key);
  if (ex) {
    if (ex.kind === "off" || ex.start == null || ex.end == null) return { kind: "off", note: ex.note };
    return { kind: "on", shift: { start: ex.start, end: ex.end }, note: ex.note, exception: true };
  }
  const s = schedule.week[weekdayOf(key)] ?? null;
  return s ? { kind: "on", shift: s, note: null, exception: false } : { kind: "off", note: null };
}

/** Every stretch of work that overlaps the span `startMs` to `endMs` (a planner column on whatever clock the screen reads), found by the shift's own start date on the carrier's clock `tz`. `tail` is a
 * block that began before the span: the end of the night before's shift. Not set gives nothing. */
export function blocksBetween(schedule: DriverSchedule | null, startMs: number, endMs: number, tz: string = activeTz()): Block[] {
  if (!schedule) return [];
  const out: Block[] = [];
  for (let k = addDaysKey(dateKeyOf(startMs, tz), -1); k <= dateKeyOf(endMs, tz); k = addDaysKey(k, 1)) {
    const own = shiftStarting(schedule, k);
    if (own.kind !== "on") continue;
    const b = blockOf(k, own.shift, tz, own.note);
    if (b.endMs > startMs && b.startMs <= endMs) out.push({ ...b, tail: b.startMs < startMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The blocks that touch one calendar day of the carrier's clock: the shift that starts on it and the tail of the night before's. */
export function blocksOnDay(schedule: DriverSchedule | null, key: string, tz: string = activeTz()): Block[] {
  const p = parts(key)!;
  return blocksBetween(schedule, centralInstant(p.y, p.m0, p.d, 0, 0, tz), centralInstant(p.y, p.m0, p.d + 1, 0, 0, tz) - 1, tz);
}

/** What a column says about a driver: not set, a day off (with the exception's note), or on shift with these blocks. */
export type DayShift = { kind: "unset" } | { kind: "off"; note: string | null } | { kind: "on"; blocks: Block[] };
export function dayShift(schedule: DriverSchedule | null, startMs: number, endMs: number, tz: string = activeTz()): DayShift {
  if (!schedule) return { kind: "unset" };
  const blocks = blocksBetween(schedule, startMs, endMs, tz);
  if (blocks.length > 0) return { kind: "on", blocks };
  const own = shiftStarting(schedule, dateKeyOf(startMs, tz));
  return { kind: "off", note: own.kind === "off" ? own.note : null };
}

/** Hours a block runs, to the half hour: 12, 12.5. */
export const blockHours = (b: Pick<Block, "startMs" | "endMs">): number => Math.round(((b.endMs - b.startMs) / 3_600_000) * 2) / 2;

const clock = (ms: number, tz: string) => {
  const p = centralParts(ms, tz);
  return { h: p.h, min: p.min };
};
/** "06:00". */
export const hhmm = (ms: number, tz: string = activeTz()): string => {
  const c = clock(ms, tz);
  return `${two(c.h)}:${two(c.min)}`;
};
/** "1:30 AM". */
export const h12 = (ms: number, tz: string = activeTz()): string => {
  const c = clock(ms, tz);
  return `${c.h % 12 === 0 ? 12 : c.h % 12}:${two(c.min)} ${c.h < 12 ? "AM" : "PM"}`;
};
/** "06:00-18:00 (12h)", for a template shift in minutes. */
export function shiftText(s: Shift): string {
  const t = (m: number) => (m === 1440 ? "24:00" : `${two(Math.floor(m / 60))}:${two(m % 60)}`);
  const len = s.end > s.start ? s.end - s.start : s.end + 1440 - s.start;
  const h = Math.round((len / 60) * 2) / 2;
  return `${t(s.start)}–${t(s.end)} (${h}h)`;
}

// ── Typed input ─────────────────────────────────────────────────────────────────────────────────

/** "06:00" or "6:00" as minutes, or null. "24:00" is allowed (midnight, for an end). */
export function parseMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}
export const minutesText = (m: number): string => `${two(Math.floor(m / 60))}:${two(m % 60)}`;

export type ShiftCheck = { ok: true; minutes: number; caution: string | null } | { ok: false; error: string };
/** A shift typed as start and end minutes. An end at or before the start is the next morning; equal start and end is refused (it is not a shift); over 14 hours is a caution. */
export function checkShift(start: number, end: number): ShiftCheck {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= 1440 || end < 0 || end > 1440) return { ok: false, error: "Times run from 00:00 to 24:00." };
  if (start === end) return { ok: false, error: "A shift needs a start and an end that differ." };
  const minutes = end > start ? end - start : end + 1440 - start;
  return { ok: true, minutes, caution: minutes > 14 * 60 ? "That is longer than the 14-hour driving window." : null };
}

/** A weekly template as stored (JSON), or null when it is not seven good entries, so an old or edited row can never invent a shift. */
export function parseWeek(json: unknown): Week | null {
  if (!Array.isArray(json) || json.length !== 7) return null;
  const week: Week = [];
  for (const d of json) {
    if (d == null) {
      week.push(null);
      continue;
    }
    const s = d as { start?: unknown; end?: unknown };
    if (typeof s.start !== "number" || typeof s.end !== "number" || !checkShift(s.start, s.end).ok) return null;
    week.push({ start: s.start, end: s.end });
  }
  return week;
}

// ── Does a stop fit the shift ───────────────────────────────────────────────────────────────────

export type StopFlag = "exceeds_end" | "before_start" | "off_duty";
export type StopCheck = { flag: StopFlag; /** The shift edge it misses: the end it is after, or the start it is before. Absent for a day off. */ edge: number | null };

/**
 * Whether a stop's window fits any of the driver's shifts. Fits when any part of the window is inside one (a window that opens before the shift ends can still be made). Otherwise: no
 * shift touches that day at all is `off_duty`; after the last shift is `exceeds_end`; before the first is `before_start`. Nothing for a driver with no schedule or a stop with no time.
 */
export function checkStop(schedule: DriverSchedule | null, window: { earliest: Date | null; latest: Date | null }, tz: string = activeTz()): StopCheck | null {
  if (!schedule) return null;
  const e = (window.earliest ?? window.latest)?.getTime();
  const l = (window.latest ?? window.earliest)?.getTime();
  if (e == null || l == null) return null;
  const lo = Math.min(e, l);
  const hi = Math.max(e, l);
  const first = dateKeyOf(lo, tz);
  const last = dateKeyOf(hi, tz);
  const blocks: Block[] = [];
  for (let k = addDaysKey(first, -1); k <= addDaysKey(last, 1); k = addDaysKey(k, 1)) {
    const own = shiftStarting(schedule, k);
    if (own.kind === "on") blocks.push(blockOf(k, own.shift, tz, own.note));
  }
  if (blocks.some((b) => lo <= b.endMs && hi >= b.startMs)) return null;
  // Is the day of the window's start touched by any shift (its own, or the night before's tail)?
  const touched = blocksOnDay(schedule, first, tz).length > 0;
  if (!touched) return { flag: "off_duty", edge: null };
  // In a gap between two shifts the stop is read against the nearer edge: 2:00 AM after a shift that ended at 1:30 AM is past its end, not early for the one at 6:00. A tie is the end.
  const before = blocks.filter((b) => b.endMs < lo).sort((a, b) => b.endMs - a.endMs)[0];
  const after = blocks.filter((b) => b.startMs > hi).sort((a, b) => a.startMs - b.startMs)[0];
  if (before && (!after || lo - before.endMs <= after.startMs - hi)) return { flag: "exceeds_end", edge: before.endMs };
  return { flag: "before_start", edge: after?.startMs ?? null };
}

export type LoadStop = { role: string | null; earliest: Date | null; latest: Date | null };
export type LoadFlag = { flag: StopFlag; role: string; at: number; edge: number | null };

/** The first stop (by time) of a load that does not fit the driver's shifts, or null when they all do. Drive time between stops is not judged. */
export function checkLoad(schedule: DriverSchedule | null, stops: LoadStop[], tz: string = activeTz()): LoadFlag | null {
  if (!schedule) return null;
  const timed = stops.filter((s) => s.earliest ?? s.latest).sort((a, b) => (a.earliest ?? a.latest)!.getTime() - (b.earliest ?? b.latest)!.getTime());
  for (const s of timed) {
    const c = checkStop(schedule, s, tz);
    if (c) return { flag: c.flag, role: s.role ?? "stop", at: (s.earliest ?? s.latest)!.getTime(), edge: c.edge };
  }
  return null;
}

export const FLAG_TAG: Record<StopFlag, string> = { exceeds_end: "EXCEEDS SHIFT END", before_start: "BEFORE SHIFT START", off_duty: "OFF DUTY" };

/** The sentence for a flag: "Delivery is after the shift ends at 1:30 AM". */
export function flagWords(f: LoadFlag, tz: string = activeTz()): string {
  const what = f.role.charAt(0).toUpperCase() + f.role.slice(1);
  if (f.flag === "off_duty") return `${what} falls on a day off.`;
  if (f.flag === "exceeds_end") return `${what} is after the shift ends${f.edge != null ? ` at ${h12(f.edge, tz)}` : ""}.`;
  return `${what} is before the shift starts${f.edge != null ? ` at ${h12(f.edge, tz)}` : ""}.`;
}

/** What /quote says beside a driver: "Past shift end (1:30 AM)". */
export function flagShort(flag: StopFlag, edge: number | null, tz: string = activeTz()): string {
  if (flag === "off_duty") return "Off duty that day";
  if (flag === "exceeds_end") return `Past shift end${edge != null ? ` (${h12(edge, tz)})` : ""}`;
  return `Before shift start${edge != null ? ` (${h12(edge, tz)})` : ""}`;
}

// ── What /quote says beside a driver ────────────────────────────────────────────────────────────

export type QuoteShift = {
  /** "Shift 06:00-18:00", "Off duty", or null when the driver has no schedule. */
  tag: string | null;
  /** "Past shift end (1:30 AM)" and so on, only when the typed pickup and delivery times are known and one falls outside the shift. */
  warn: string | null;
  /** The sentence for the tooltip. */
  title: string | null;
};
export const NO_QUOTE_SHIFT: QuoteShift = { tag: null, warn: null, title: null };

/**
 * The shift beside a driver on a quote: the hours they work on the pickup's day (or today when no time is typed), and, when the pickup and delivery appointments are typed, whether one falls
 * outside their shift. A caution next to the hours-left one: the verdict and the ranking never read it. No schedule says nothing.
 */
export function quoteShift(schedule: DriverSchedule | null, stops: Array<{ role: string; appointment: number | null }>, now: number, tz: string = activeTz()): QuoteShift {
  if (!schedule) return NO_QUOTE_SHIFT;
  const timed = stops.filter((s) => s.appointment != null);
  const day = dateKeyOf(timed[0]?.appointment ?? now, tz);
  const blocks = blocksOnDay(schedule, day, tz);
  const tag = blocks.length === 0 ? "Off duty" : blocks.map((b) => (b.tail ? `Shift until ${hhmm(b.endMs, tz)}` : `Shift ${hhmm(b.startMs, tz)}–${hhmm(b.endMs, tz)}`)).join(" + ");
  if (timed.length === 0) return { tag, warn: null, title: null };
  const f = checkLoad(schedule, timed.map((s) => ({ role: s.role, earliest: new Date(s.appointment!), latest: new Date(s.appointment!) })), tz);
  return f ? { tag, warn: flagShort(f.flag, f.edge, tz), title: flagWords(f, tz) } : { tag, warn: null, title: null };
}

// ── Changing a schedule under booked freight ────────────────────────────────────────────────────

export type BookedLoad = { loadId: string; loadNumber: string | null; stops: LoadStop[] };
export type ShiftConflict = { loadId: string; loadNumber: string | null; flag: LoadFlag };

/** The booked loads a new schedule would put outside the driver's shifts that the old one did not: what to tell a driver manager before they cut a shift or mark a day off. */
export function conflictsIfChanged(oldSchedule: DriverSchedule | null, newSchedule: DriverSchedule | null, loads: BookedLoad[], tz: string = activeTz()): ShiftConflict[] {
  const out: ShiftConflict[] = [];
  for (const l of loads) {
    const now = checkLoad(newSchedule, l.stops, tz);
    if (!now) continue;
    if (checkLoad(oldSchedule, l.stops, tz)) continue; // it was already outside the old one: nothing new is being broken
    out.push({ loadId: l.loadId, loadNumber: l.loadNumber, flag: now });
  }
  return out;
}

// ── Supply and demand ───────────────────────────────────────────────────────────────────────────

export type DayBalance = { need: number; available: number; unscheduled: number };
export type BalanceDriver = { schedule: DriverSchedule | null; busy: Array<{ start: number; end: number }> };

/**
 * For each day: how many loads need a driver (given by the caller, the tray's loads on that day), how many scheduled drivers are on shift with nothing open that overlaps their shift, and how
 * many drivers have no schedule at all (so no one is told they are free or busy by a guess).
 */
export function dayBalance(days: Array<{ key: string; start: number; end: number }>, drivers: BalanceDriver[], need: number[], tz: string = activeTz()): DayBalance[] {
  return days.map((d, i) => {
    let available = 0;
    let unscheduled = 0;
    for (const dr of drivers) {
      if (!dr.schedule) {
        unscheduled++;
        continue;
      }
      const blocks = blocksBetween(dr.schedule, d.start, d.end, tz).map((b) => ({ start: Math.max(b.startMs, d.start), end: Math.min(b.endMs, d.end + 1) }));
      if (blocks.length === 0) continue;
      const free = blocks.some((b) => !dr.busy.some((w) => w.start < b.end && b.start < w.end));
      if (free) available++;
    }
    return { need: need[i] ?? 0, available, unscheduled };
  });
}

export const DAY_MS = DAY;
