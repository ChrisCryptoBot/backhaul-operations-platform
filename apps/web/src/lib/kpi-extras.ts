import { DAY_MS, inWindow, type TimeWindow } from "./kpi-periods";

/**
 * The small, pure rules behind the KPI's quick wins (docs/LEAK_AUDIT_2026-11.md): how long ahead a load was booked, which share of loads and revenue each kind of freight is, how many offers
 * became loads, whether a lane pays what its target says, and the diesel price in force at the end of a week. The server reads the rows; this turns them into figures, so each can be checked
 * against plain data.
 */

/** A load that was moved to a new pickup time (an audit event `rescheduled`), and the reason that was picked. */
export type RolledEvent = { loadId: string; at: number; reason: string | null };
/** One offer (a saved quote): booked into a load, passed on, or still open. `at` is when it was decided, or saved when it is still open. */
export type TenderRow = { at: number; kind: "booked" | "passed" | "open" };
/** The weekly diesel price (`weekOf` is the EIA week's date, YYYY-MM-DD). */
export type DieselPoint = { weekOf: string; price: number };
export type KpiExtras = { rolled?: RolledEvent[]; tenders?: TenderRow[]; laneTargets?: ReadonlyMap<string, number>; diesel?: DieselPoint[] };

/** Days from the day a load was booked to its pickup, to a tenth: null when there is no pickup date or it is before the booking (a load keyed in after the fact). */
export function leadDaysOf(createdAt: Date, scheduled: Date | null): number | null {
  if (!scheduled) return null;
  const d = (scheduled.getTime() - createdAt.getTime()) / DAY_MS;
  return d < 0 ? null : d;
}

export type MixRow = { key: string; label: string; loads: number; loadShare: number; gross: number; grossShare: number };

/** Each group's share of the loads and of the revenue, biggest revenue first. `none` names the group with nothing recorded. */
export function mixOf(items: ReadonlyArray<{ key: string | null; gross: number }>, labelOf: (key: string) => string, none = "Not recorded"): MixRow[] {
  const groups = new Map<string, { loads: number; gross: number }>();
  for (const i of items) {
    const k = i.key && i.key.trim() !== "" ? i.key : "";
    const g = groups.get(k) ?? { loads: 0, gross: 0 };
    g.loads += 1;
    g.gross += i.gross;
    groups.set(k, g);
  }
  const loads = items.length;
  const gross = items.reduce((s, i) => s + i.gross, 0);
  return [...groups.entries()]
    .map(([key, g]) => ({ key: key || "none", label: key === "" ? none : labelOf(key), loads: g.loads, loadShare: loads > 0 ? g.loads / loads : 0, gross: g.gross, grossShare: gross > 0 ? g.gross / gross : 0 }))
    .sort((a, b) => b.gross - a.gross || b.loads - a.loads || a.label.localeCompare(b.label));
}

export type TenderStats = { received: number; booked: number; passed: number; open: number; acceptance: number | null };

/** Offers in a window: how many came in, how many were booked, passed, or are still open, and the share booked of those received. Null with none received. */
export function tenderStats(rows: readonly TenderRow[], w: TimeWindow): TenderStats {
  const inside = rows.filter((r) => inWindow(r.at, w));
  const booked = inside.filter((r) => r.kind === "booked").length;
  const passed = inside.filter((r) => r.kind === "passed").length;
  const open = inside.filter((r) => r.kind === "open").length;
  const received = inside.length;
  return { received, booked, passed, open, acceptance: received > 0 ? booked / received : null };
}

export type LaneScore = "below" | "ok" | "no_target";

/** A lane against its target rate per load: below it, at or above it, or no target set. */
export function laneScore(revPerLoad: number | null, target: number | null | undefined): LaneScore {
  if (target == null || !(target > 0) || revPerLoad == null) return "no_target";
  return revPerLoad < target ? "below" : "ok";
}

/** The diesel price in force at a moment: the newest week on or before it, or null with none. `weekOf` sorts as text (YYYY-MM-DD). */
export function dieselAt(points: readonly DieselPoint[], atMs: number): number | null {
  const day = new Date(atMs).toISOString().slice(0, 10);
  let best: DieselPoint | null = null;
  for (const p of points) if (p.weekOf <= day && (!best || p.weekOf > best.weekOf)) best = p;
  return best ? best.price : null;
}

/** A change as a fraction of what it was, null with nothing to compare against. */
export const changeOf = (now: number | null, was: number | null): number | null => (now == null || was == null || was === 0 ? null : (now - was) / Math.abs(was));

/** The trailer kinds as the desk says them. Anything else is shown as typed, tidied. */
const TRAILER_LABELS: Record<string, string> = { dry_van: "Dry van", reefer: "Reefer", flatbed: "Flatbed", step_deck: "Step deck", rgn: "RGN", conestoga: "Conestoga", tanker: "Tanker", car_hauler: "Car hauler", power_only: "Power only", box_truck: "Box truck", hotshot: "Hotshot" };
export const mixLabel = (key: string): string => TRAILER_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
