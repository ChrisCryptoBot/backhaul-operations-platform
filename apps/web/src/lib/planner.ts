import { centralMidnight, centralParts } from "./zoned";
import { loadWindow, windowsOverlap } from "./schedule";

/**
 * The planner: who is on what, day by day, and what is due now. Both read the loads' stop windows and the arrival times the phone
 * reports. Pure, so it is tested with plain data; days are the Central calendar days.
 */
export type PlannerStop = {
  sequence: number;
  type: string;
  role: string | null;
  facility: string | null;
  city: string;
  earliest: Date | null;
  latest: Date | null;
  arrivedAt: Date | null;
};

export type PlannerLoad = {
  id: string;
  loadNumber: string | null;
  origin: string | null;
  destination: string | null;
  status: string;
  driverId: string | null;
  driverName: string | null;
  assignmentStatus: string | null;
  stops: PlannerStop[];
};

export type DayCol = { key: string; weekday: string; label: string; start: number; end: number; isToday: boolean };

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** `count` Central days beginning with the day `from` falls in. */
export function planDays(from: number, count: number, now: number): DayCol[] {
  const f = centralParts(from);
  const today = centralParts(now);
  return Array.from({ length: count }, (_, i) => {
    const start = centralMidnight(f.y, f.m0, f.d + i);
    const next = centralMidnight(f.y, f.m0, f.d + i + 1);
    const p = centralParts(start + 12 * 3_600_000); // noon, so a daylight-saving day cannot tip it onto its neighbour
    return {
      key: `${p.y}-${two(p.m0 + 1)}-${two(p.d)}`,
      weekday: WD[new Date(Date.UTC(p.y, p.m0, p.d)).getUTCDay()]!,
      label: `${MON[p.m0]} ${p.d}`,
      start,
      end: next - 1,
      isToday: p.y === today.y && p.m0 === today.m0 && p.d === today.d
    };
  });
}

const OPEN = ["draft", "accepted", "in_progress"];
const city = (a: string | null) => (a ?? "?").split(",")[0]!;

export type PlannerItem = {
  loadId: string;
  loadNumber: string | null;
  lane: string;
  status: string;
  assignmentStatus: string | null;
  start: number;
  end: number;
  /** The first day this load shows on, and the last. */
  startsHere: boolean;
  endsHere: boolean;
  /** The same driver is on another open load at the same time. */
  conflict: boolean;
  /** Assigned to a driver but not sent yet. */
  notSent: boolean;
  /** Delivered: shown so the week reads whole, but not a commitment any more. */
  done: boolean;
};

export type PlannerRow = { driverId: string; name: string; cells: PlannerItem[][] };

/** An open load with no pickup or delivery time on any stop: it cannot sit on a day, so it is listed beside the grid instead of vanishing. */
export type UntimedLoad = { loadId: string; loadNumber: string | null; lane: string; status: string; driverName: string | null };

/**
 * One row per driver and a tray of loads that have no driver (or whose driver declined), each as a list of loads per day.
 * A load that is on the road keeps its driver's row until it is delivered, so with `now` its span runs at least to now: a truck that is late
 * on a delivery whose window closed yesterday is still in its row today, not only in the due list.
 */
export function buildPlanner(loads: PlannerLoad[], drivers: Array<{ id: string; name: string }>, days: DayCol[], now?: number): { rows: PlannerRow[]; tray: PlannerItem[][]; untimed: UntimedLoad[] } {
  type Raw = { l: PlannerLoad; start: number; end: number };
  const raws: Raw[] = [];
  const untimed: UntimedLoad[] = [];
  for (const l of loads) {
    if (l.status !== "completed" && !OPEN.includes(l.status)) continue;
    const w = loadWindow(l.stops.map((s) => ({ timeWindowEarliest: s.earliest, timeWindowLatest: s.latest })));
    if (w) raws.push({ l, start: w.start.getTime(), end: l.status === "in_progress" && now != null ? Math.max(w.end.getTime(), now) : w.end.getTime() });
    else if (OPEN.includes(l.status)) untimed.push({ loadId: l.id, loadNumber: l.loadNumber, lane: `${city(l.origin)} → ${city(l.destination)}`, status: l.status, driverName: l.assignmentStatus !== "declined" ? l.driverName : null });
  }

  const driverOf = (r: Raw) => (r.l.driverId && r.l.assignmentStatus !== "declined" ? r.l.driverId : null);
  // Grouped by driver once (insertion order is the order each driver first appears), so a fleet of thousands is not compared load against load.
  const byDriver = new Map<string, Raw[]>();
  for (const r of raws) {
    const id = driverOf(r);
    if (!id) continue;
    const list = byDriver.get(id);
    if (list) list.push(r);
    else byDriver.set(id, [r]);
  }
  // Two open loads of one driver conflict when their windows overlap (back to back is fine, as windowsOverlap says).
  const conflicting = new Set<string>();
  for (const list of byDriver.values()) {
    const open = list.filter((r) => OPEN.includes(r.l.status));
    for (const a of open) for (const b of open) if (a !== b && a.start < b.end && b.start < a.end) conflicting.add(a.l.id);
  }

  const item = (r: Raw, day: DayCol): PlannerItem => ({
    loadId: r.l.id,
    loadNumber: r.l.loadNumber,
    lane: `${city(r.l.origin)} → ${city(r.l.destination)}`,
    status: r.l.status,
    assignmentStatus: r.l.assignmentStatus,
    start: r.start,
    end: r.end,
    startsHere: r.start >= day.start,
    endsHere: r.end <= day.end,
    conflict: conflicting.has(r.l.id),
    notSent: r.l.assignmentStatus === "draft",
    done: r.l.status === "completed"
  });
  const cellsFor = (rs: Raw[]) => days.map((d) => rs.filter((r) => r.start <= d.end && r.end >= d.start).sort((a, b) => a.start - b.start).map((r) => item(r, d)));

  const known = new Set(drivers.map((d) => d.id));
  const rows: PlannerRow[] = drivers.map((d) => ({ driverId: d.id, name: d.name, cells: cellsFor(byDriver.get(d.id) ?? []) }));
  // A driver who is no longer in the list but still holds a load must not vanish from the board.
  for (const [id, list] of byDriver) {
    if (known.has(id)) continue;
    known.add(id);
    rows.push({ driverId: id, name: list[0]!.l.driverName ?? "Former driver", cells: cellsFor(list) });
  }
  const tray = cellsFor(raws.filter((r) => !driverOf(r) && OPEN.includes(r.l.status)));
  return { rows, tray, untimed };
}

export type DueState = "past_due" | "today" | "upcoming" | "done";

export type DueItem = {
  loadId: string;
  loadNumber: string | null;
  stopRole: string;
  facility: string | null;
  city: string;
  earliest: Date | null;
  due: Date;
  arrivedAt: Date | null;
  state: DueState;
  /** Arrived after the window closed, and by how many minutes. */
  late: boolean;
  minutesLate: number | null;
  /** Not there yet and the window has closed, by how many minutes. */
  minutesOver: number | null;
  driverName: string | null;
  status: string;
};

const STATE_ORDER: Record<DueState, number> = { past_due: 0, today: 1, upcoming: 2, done: 3 };
const sameDay = (a: number, b: number) => {
  const x = centralParts(a);
  const y = centralParts(b);
  return x.y === y.y && x.m0 === y.m0 && x.d === y.d;
};

/**
 * The stops that need eyes now. Past due (the window closed and nobody has arrived) first, then due today, then due in the next
 * `upcomingDays` days, then stops that were reached today (on time, or late and by how much).
 */
export function buildWatchlist(loads: PlannerLoad[], now: number, upcomingDays = 1): DueItem[] {
  const horizon = centralMidnight(centralParts(now).y, centralParts(now).m0, centralParts(now).d + 1 + upcomingDays) - 1;
  const out: DueItem[] = [];
  for (const l of loads) {
    if (l.status !== "completed" && !OPEN.includes(l.status)) continue;
    for (const s of l.stops) {
      const due = s.latest ?? s.earliest;
      if (!due) continue;
      const base = { loadId: l.id, loadNumber: l.loadNumber, stopRole: s.role ?? s.type, facility: s.facility, city: s.city, earliest: s.earliest, due, arrivedAt: s.arrivedAt, driverName: l.driverName, status: l.status };
      if (s.arrivedAt) {
        if (!sameDay(s.arrivedAt.getTime(), now)) continue;
        const over = (s.arrivedAt.getTime() - due.getTime()) / 60_000;
        out.push({ ...base, state: "done", late: over > 0, minutesLate: over > 0 ? Math.round(over) : null, minutesOver: null });
        continue;
      }
      if (!OPEN.includes(l.status)) continue; // a finished load with no recorded arrival is a gap in the data, not a stop to chase
      const t = due.getTime();
      if (t < now) out.push({ ...base, state: "past_due", late: false, minutesLate: null, minutesOver: Math.round((now - t) / 60_000) });
      else if (sameDay(t, now)) out.push({ ...base, state: "today", late: false, minutesLate: null, minutesOver: null });
      else if (t <= horizon) out.push({ ...base, state: "upcoming", late: false, minutesLate: null, minutesOver: null });
    }
  }
  return out.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.due.getTime() - b.due.getTime());
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/** What a planner cell says about a load's time on that day: when it starts, when it ends, or that it runs all day. */
export function timeText(i: Pick<PlannerItem, "start" | "end" | "startsHere" | "endsHere">): string {
  if (i.startsHere && i.endsHere) return `${clock(i.start)} to ${clock(i.end)}`;
  if (i.startsHere) return `from ${clock(i.start)}`;
  if (i.endsHere) return `until ${clock(i.end)}`;
  return "all day";
}

/** "2 h 10 min" or "35 min". */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}
