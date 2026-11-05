import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { addDaysKey, checkShift, conflictsIfChanged, dateKeyOf, parseWeek, shiftText, weekdayOf, type BookedLoad, type DriverSchedule, type ShiftConflict, type TimeOff, type Week } from "@/lib/shifts";
import { pageCount } from "@/lib/paging";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * Shifts on the server: who has a schedule, saving one, time off, and what a change would do to freight already booked. Shifts are on the carrier's clock (the workspace's zone). A schedule that
 * would put a booked load outside the shift is not saved the first time: the people it would surprise are listed and the manager chooses (`force`). Never a rule, only a warning.
 */
const OPEN_LOAD = ["draft", "accepted", "in_progress"];
const OPEN_ASSIGNMENT = ["draft", "dispatched", "accepted", "in_progress"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KEY = /^\d{4}-\d{2}-\d{2}$/;

type Db = Prisma.TransactionClient | typeof prisma;

const exOf = (e: { dateKey: string; kind: string; startMinute: number | null; endMinute: number | null; note: string | null }): TimeOff => ({ dateKey: e.dateKey, kind: e.kind === "shift" ? "shift" : "off", start: e.startMinute, end: e.endMinute, note: e.note });

/** The schedules of these drivers (all of the workspace's when none are named), with the time off that falls from `fromKey` on (a day before it, for a night shift's tail). A driver with no row or a broken row is absent: not set. */
export async function loadSchedules(workspaceId: string, driverIds: string[] | null, fromKey: string, toKey: string | null = null, db: Db = prisma): Promise<Map<string, DriverSchedule>> {
  const scope = driverIds ? { driverId: { in: driverIds } } : {};
  const [rows, exs] = await Promise.all([
    db.driverSchedule.findMany({ where: { workspaceId, ...scope }, select: { driverId: true, week: true } }),
    db.driverShiftException.findMany({ where: { workspaceId, ...scope, dateKey: { gte: addDaysKey(fromKey, -1), ...(toKey ? { lte: addDaysKey(toKey, 1) } : {}) } }, orderBy: { dateKey: "asc" } })
  ]);
  const out = new Map<string, DriverSchedule>();
  for (const r of rows) {
    const week = parseWeek(r.week);
    if (week) out.set(r.driverId, { week, exceptions: [] });
  }
  for (const e of exs) out.get(e.driverId)?.exceptions.push(exOf(e));
  return out;
}

/** A driver's open loads with their stops: what a schedule change could put outside the shift. */
export async function bookedLoadsOf(driverIds: string[], workspaceId: string, db: Db = prisma): Promise<Map<string, BookedLoad[]>> {
  const out = new Map<string, BookedLoad[]>();
  if (driverIds.length === 0) return out;
  const rows = await db.assignment.findMany({
    where: { driverId: { in: driverIds }, status: { in: OPEN_ASSIGNMENT }, load: { workspaceId, deletedAt: null, status: { in: OPEN_LOAD } } },
    select: { driverId: true, load: { select: { id: true, loadNumber: true, stops: { select: { stopRole: true, stopType: true, timeWindowEarliest: true, timeWindowLatest: true } } } } }
  });
  for (const r of rows) {
    const list = out.get(r.driverId) ?? [];
    list.push({ loadId: r.load.id, loadNumber: r.load.loadNumber, stops: r.load.stops.map((s) => ({ role: s.stopRole ?? s.stopType, earliest: s.timeWindowEarliest, latest: s.timeWindowLatest })) });
    out.set(r.driverId, list);
  }
  return out;
}

export type ConflictView = { driverId: string; driverName: string; loads: Array<{ loadId: string; loadNumber: string | null }>; text: string };
export type ShiftResult = { ok: true } | { ok: false; error: string } | { ok: false; conflicts: ConflictView[] };

/** "Casey Brooks has 1 load assigned on Friday (DM-40009). Setting to Off Duty will create a shift conflict for dispatch." */
function conflictText(name: string, list: ShiftConflict[], tz: string): string {
  const days = [...new Set(list.map((c) => DAY_NAMES[weekdayOf(dateKeyOf(c.flag.at, tz))]!))];
  const nums = list.map((c) => c.loadNumber ?? "a load").join(", ");
  const allOff = list.every((c) => c.flag.flag === "off_duty");
  const n = list.length;
  return `${name} has ${n} ${n === 1 ? "load" : "loads"} assigned ${days.length === 1 ? `on ${days[0]}` : `on ${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`} (${nums}). ${allOff ? "Setting to Off Duty" : "That change"} will create a shift conflict for dispatch.`;
}

async function previewConflicts(drivers: Array<{ id: string; name: string }>, next: Map<string, DriverSchedule | null>, workspaceId: string, tz: string, db: Db): Promise<ConflictView[]> {
  const ids = drivers.map((d) => d.id);
  const today = dateKeyOf(Date.now(), tz);
  const [before, booked] = await Promise.all([loadSchedules(workspaceId, ids, today, null, db), bookedLoadsOf(ids, workspaceId, db)]);
  const out: ConflictView[] = [];
  for (const d of drivers) {
    const found = conflictsIfChanged(before.get(d.id) ?? null, next.get(d.id) ?? null, booked.get(d.id) ?? [], tz);
    if (found.length > 0) out.push({ driverId: d.id, driverName: d.name, loads: found.map((c) => ({ loadId: c.loadId, loadNumber: c.loadNumber })), text: conflictText(d.name, found, tz) });
  }
  return out;
}

/** The load numbers a saved-anyway change leaves outside the shift, for the audit entry ("Conflicting loads: DM-40009"). */
const conflictNumbers = (list: ConflictView[]): string | null => (list.length === 0 ? null : list.flatMap((c) => c.loads.map((l) => l.loadNumber ?? "a load")).join(", "));

const weekView = (w: Week | null): Record<string, string | null> => Object.fromEntries(SHORT.map((d, i) => [d, w ? (w[i] ? shiftText(w[i]!) : "Off") : "Not set"]));

/** Whether typed shifts are sane, with the first problem in words. */
export function checkWeek(week: unknown): { ok: true; week: Week; cautions: string[] } | { ok: false; error: string } {
  const w = parseWeek(week);
  if (!w) return { ok: false, error: "A week is seven days, each a shift (a start and an end that differ) or a day off." };
  const cautions: string[] = [];
  w.forEach((s, i) => {
    if (!s) return;
    const c = checkShift(s.start, s.end);
    if (c.ok && c.caution) cautions.push(`${DAY_NAMES[i]}: ${c.caution}`);
  });
  return { ok: true, week: w, cautions };
}

/** Save one driver's weekly template. */
export async function saveSchedule(driverId: string, weekInput: unknown, opts: { force?: boolean; now?: Date; by?: string | null } = {}, workspaceId = currentWorkspaceId()): Promise<ShiftResult> {
  return applySchedule([driverId], weekInput, opts, workspaceId);
}

/** The same weekly template for several drivers at once ("every weekday 06:00 to 18:00 for these twenty"). */
export async function applySchedule(driverIds: string[], weekInput: unknown, opts: { force?: boolean; now?: Date; by?: string | null } = {}, workspaceId = currentWorkspaceId()): Promise<ShiftResult> {
  const checked = checkWeek(weekInput);
  if (!checked.ok) return checked;
  const ids = [...new Set(driverIds)];
  if (ids.length === 0) return { ok: false, error: "Pick at least one driver." };
  const drivers = await prisma.driver.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, name: true } });
  if (drivers.length !== ids.length) return { ok: false, error: "One of those drivers is not on this desk." };
  const tz = await workspaceTimezone(workspaceId);
  const today = dateKeyOf(Date.now(), tz);
  const existing = await loadSchedules(workspaceId, ids, today);
  const next = new Map<string, DriverSchedule | null>(drivers.map((d) => [d.id, { week: checked.week, exceptions: existing.get(d.id)?.exceptions ?? [] }]));
  // Checked every time: without `force` a conflict stops the save and is shown; with it the save goes ahead and the audit entry names the loads it left outside the shift.
  const conflicts = await previewConflicts(drivers, next, workspaceId, tz, prisma);
  if (conflicts.length > 0 && !opts.force) return { ok: false, conflicts };
  const now = opts.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    const was = await tx.driverSchedule.findMany({ where: { workspaceId, driverId: { in: ids } }, select: { driverId: true, week: true } });
    const wasOf = new Map(was.map((w) => [w.driverId, parseWeek(w.week)]));
    for (const d of drivers) {
      await tx.driverSchedule.upsert({ where: { driverId: d.id }, create: { workspaceId, driverId: d.id, week: checked.week as unknown as Prisma.InputJsonValue, setBy: opts.by ?? null }, update: { week: checked.week as unknown as Prisma.InputJsonValue, setBy: opts.by ?? null } });
      const mine = conflictNumbers(conflicts.filter((c) => c.driverId === d.id));
      await recordAudit({ entity: "fleet", entityId: d.id, action: "schedule_changed", summary: `${d.name}: shift schedule set${mine ? `, saved with a conflict (${mine})` : ""}`, before: weekView(wasOf.get(d.id) ?? null), after: { ...weekView(checked.week), ...(mine ? { "Conflicting loads": mine } : {}) }, at: now, workspaceId }, tx);
    }
  });
  return { ok: true };
}

/** Take a driver's schedule away: back to not set (never flagged, not counted as supply). */
export async function clearSchedule(driverId: string, opts: { now?: Date } = {}, workspaceId = currentWorkspaceId()): Promise<ShiftResult> {
  const d = await prisma.driver.findFirst({ where: { id: driverId, workspaceId }, select: { id: true, name: true } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  const was = await prisma.driverSchedule.findUnique({ where: { driverId } });
  if (!was) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.driverSchedule.delete({ where: { driverId } });
    await recordAudit({ entity: "fleet", entityId: driverId, action: "schedule_changed", summary: `${d.name}: shift schedule cleared`, before: weekView(parseWeek(was.week)), after: weekView(null), at: opts.now ?? new Date(), workspaceId }, tx);
  });
  return { ok: true };
}

export type TimeOffInput = { dateKey: string; kind: string; start?: number | null; end?: number | null; note?: string | null };

/** One date that differs from the template: time off (`off`) or another shift (`shift`). Setting a date again replaces it. */
export async function saveTimeOff(driverId: string, input: TimeOffInput, opts: { force?: boolean; now?: Date } = {}, workspaceId = currentWorkspaceId()): Promise<ShiftResult> {
  if (!KEY.test(input.dateKey)) return { ok: false, error: "Pick a date." };
  if (input.kind !== "off" && input.kind !== "shift") return { ok: false, error: "Time off or a different shift." };
  let start: number | null = null;
  let end: number | null = null;
  if (input.kind === "shift") {
    if (input.start == null || input.end == null) return { ok: false, error: "A different shift needs a start and an end." };
    const c = checkShift(input.start, input.end);
    if (!c.ok) return { ok: false, error: c.error };
    start = input.start;
    end = input.end;
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 120) : null;
  const d = await prisma.driver.findFirst({ where: { id: driverId, workspaceId }, select: { id: true, name: true } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  const tz = await workspaceTimezone(workspaceId);
  const cur = (await loadSchedules(workspaceId, [driverId], input.dateKey)).get(driverId) ?? null;
  if (!cur) return { ok: false, error: "Set this driver's weekly shifts first; time off is a change to them." };
  const next: DriverSchedule = { week: cur.week, exceptions: [...cur.exceptions.filter((e) => e.dateKey !== input.dateKey), { dateKey: input.dateKey, kind: input.kind, start, end, note }] };
  const conflicts = await previewConflicts([d], new Map([[driverId, next]]), workspaceId, tz, prisma);
  if (conflicts.length > 0 && !opts.force) return { ok: false, conflicts };
  const mine = conflictNumbers(conflicts);
  await prisma.$transaction(async (tx) => {
    await tx.driverShiftException.upsert({ where: { driverId_dateKey: { driverId, dateKey: input.dateKey } }, create: { workspaceId, driverId, dateKey: input.dateKey, kind: input.kind, startMinute: start, endMinute: end, note }, update: { kind: input.kind, startMinute: start, endMinute: end, note } });
    await recordAudit({ entity: "fleet", entityId: driverId, action: "time_off_added", summary: `${d.name}: ${input.kind === "off" ? "off duty" : "different shift"} on ${input.dateKey}${mine ? `, saved with a conflict (${mine})` : ""}`, before: null, after: { Date: input.dateKey, Kind: input.kind === "off" ? "Off duty" : "Different shift", Shift: input.kind === "shift" ? shiftText({ start: start!, end: end! }) : null, Note: note, ...(mine ? { "Conflicting loads": mine } : {}) }, at: opts.now ?? new Date(), workspaceId }, tx);
  });
  return { ok: true };
}

/** Put a date back to the template. */
export async function removeTimeOff(driverId: string, dateKey: string, opts: { force?: boolean; now?: Date } = {}, workspaceId = currentWorkspaceId()): Promise<ShiftResult> {
  const d = await prisma.driver.findFirst({ where: { id: driverId, workspaceId }, select: { id: true, name: true } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  const row = await prisma.driverShiftException.findUnique({ where: { driverId_dateKey: { driverId, dateKey } } });
  if (!row || row.workspaceId !== workspaceId) return { ok: true };
  const tz = await workspaceTimezone(workspaceId);
  const cur = (await loadSchedules(workspaceId, [driverId], dateKey)).get(driverId) ?? null;
  let mine: string | null = null;
  if (cur) {
    const next: DriverSchedule = { week: cur.week, exceptions: cur.exceptions.filter((e) => e.dateKey !== dateKey) };
    const conflicts = await previewConflicts([d], new Map([[driverId, next]]), workspaceId, tz, prisma);
    if (conflicts.length > 0 && !opts.force) return { ok: false, conflicts };
    mine = conflictNumbers(conflicts);
  }
  await prisma.$transaction(async (tx) => {
    await tx.driverShiftException.delete({ where: { id: row.id } });
    await recordAudit({ entity: "fleet", entityId: driverId, action: "time_off_removed", summary: `${d.name}: ${dateKey} back to the weekly shift${mine ? `, saved with a conflict (${mine})` : ""}`, before: { Date: dateKey, Kind: row.kind === "off" ? "Off duty" : "Different shift" }, after: mine ? { "Conflicting loads": mine } : null, at: opts.now ?? new Date(), workspaceId }, tx);
  });
  return { ok: true };
}

export type ScheduleRow = { driverId: string; name: string; code: string | null; terminal: string | null; schedule: DriverSchedule | null; timeOff: TimeOff[] };

/** One page of the roster for the Schedules screen: active drivers by name, with the template and the upcoming time off. Search matches a name or a code. */
export async function listScheduleRows(query: { q?: string; page?: number; pageSize?: number; terminal?: string | null }, now = Date.now(), workspaceId = currentWorkspaceId()) {
  const pageSize = query.pageSize ?? 50;
  const q = query.q?.trim() ?? "";
  const where: Prisma.DriverWhereInput = {
    workspaceId,
    active: true,
    ...(query.terminal ? { terminal: query.terminal } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }] } : {})
  };
  const total = await prisma.driver.count({ where });
  const pages = pageCount(total, pageSize);
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const drivers = await prisma.driver.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, name: true, code: true, terminal: true } });
  const tz = await workspaceTimezone(workspaceId);
  const today = dateKeyOf(now, tz);
  const sched = await loadSchedules(workspaceId, drivers.map((d) => d.id), today);
  const rows: ScheduleRow[] = drivers.map((d) => ({ driverId: d.id, name: d.name, code: d.code, terminal: d.terminal, schedule: sched.get(d.id) ?? null, timeOff: (sched.get(d.id)?.exceptions ?? []).filter((e) => e.dateKey >= today) }));
  const unset = await prisma.driver.count({ where: { workspaceId, active: true, schedule: { is: null } } });
  return { rows, total, page, pages, pageSize, unset, tz };
}
