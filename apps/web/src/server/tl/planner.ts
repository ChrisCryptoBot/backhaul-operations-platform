import { Prisma } from "@prisma/client";
import { termList, terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { buildPlanner, buildWatchlist, planDays, type PlannerLoad } from "@/lib/planner";
import { currentWorkspaceId } from "./workspace";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { activeTz } from "@/lib/tz";
import { dateKeyOf } from "@/lib/shifts";
import { loadSchedules } from "./shifts";
import { workspaceTimezone } from "./zone";

/** The planner's data: seven Central days from `from`, every active driver's loads by day, the loads still waiting for a driver, and what is due now. */
/**
 * `terminal`: only that scope's home drivers get a row, and loads held by drivers based elsewhere are left off (their number is `hiddenElsewhere`, so the page can offer to include them); loads nobody holds yet
 * stay for everyone. The scope is part of the read, so the loads of the other terminals are never read at all. `reach` is what the person may see whatever they have chosen (null: everything): `hiddenElsewhere` counts only
 * what the "everyone" link could show them, never loads outside their limit.
 */
export async function getPlannerData(from: number, now: number = Date.now(), count = 7, workspaceId = currentWorkspaceId(), terminal: Terminals = null, reach: Terminals = null) {
  // Only what the board can show: every open load (they are the commitments, and the ones with no times are listed beside the grid) and the delivered loads
  // that fall in or near the days shown. A fleet has tens of thousands of finished loads, none of which belong on this week.
  const days0 = planDays(from, count, now);
  const near = { gte: new Date(days0[0]!.start - 2 * 86_400_000), lte: new Date(days0[days0.length - 1]!.end + 2 * 86_400_000) };
  // The loads are named first, by two cheap lookups, and only those are read in full: the open ones (an index) and the delivered ones with a stop in the days shown
  // (one pass over the stops). Asking for both at once, as one query, made the database test every load against every stop.
  // A load is in a scope when nobody holds it yet or its driver is an active driver based there (the same rule the grid's rows use).
  const heldIn = (t: Terminals) => {
    const list = termList(t);
    return list == null
      ? Prisma.empty
      : Prisma.sql` and (not exists (select 1 from assignments a where a.load_id = l.id) or exists (select 1 from assignments a join drivers d on d.id = a.driver_id where a.load_id = l.id and d.active and d.terminal = any(${list})))`;
  };
  const namedIn = (t: Terminals) =>
    prisma.$queryRaw<Array<{ id: string }>>`
      select l.id from loads l where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status in ('draft', 'accepted', 'in_progress')${heldIn(t)}
      union
      select l.id from loads l join stops s on s.load_id = l.id
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed'${heldIn(t)}
        and ((s.time_window_earliest >= ${near.gte} and s.time_window_earliest <= ${near.lte}) or (s.time_window_latest >= ${near.gte} and s.time_window_latest <= ${near.lte}))`;
  const [named, reachable, drivers] = await Promise.all([
    namedIn(terminal),
    terminal != null ? namedIn(reach) : Promise.resolve(null),
    prisma.driver.findMany({ where: { workspaceId, active: true, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } })
  ]);
  const loads = named.length === 0 ? [] : await prisma.load.findMany({ where: { id: { in: named.map((n) => n.id) } }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: { include: { driver: true } } } });
  const planner: PlannerLoad[] = loads.map((l) => ({
    id: l.id,
    loadNumber: l.loadNumber,
    origin: l.originAddress,
    destination: l.destinationAddress,
    status: l.status,
    driverId: l.assignment?.driverId ?? null,
    driverName: l.assignment?.driver.name ?? null,
    assignmentStatus: l.assignment?.status ?? null,
    stops: l.stops.map((s) => ({
      sequence: s.stopSequence,
      type: s.stopType,
      role: s.stopRole,
      facility: s.facilityName,
      city: s.addressString.split(",")[0]!,
      earliest: s.timeWindowEarliest,
      latest: s.timeWindowLatest,
      arrivedAt: s.arrivedAt,
      zone: stopZoneOf(s, activeTz())
    }))
  }));
  const days = days0;
  const visible = planner;
  // Shifts are the carrier's clock (the workspace's zone); a column is matched to them by the instants it spans, so a desk reading another clock still lines up.
  const tz = await workspaceTimezone(workspaceId);
  const schedules = await loadSchedules(workspaceId, drivers.map((d) => d.id), dateKeyOf(days[0]!.start, tz), dateKeyOf(days[days.length - 1]!.end, tz));
  const hiddenElsewhere = reachable == null ? 0 : reachable.length > named.length ? reachable.length - named.length : 0;
  return { days, hiddenElsewhere, ...buildPlanner(visible, drivers.map((d) => ({ id: d.id, name: d.name, code: d.code })), days, now, { schedules, tz }), watchlist: buildWatchlist(visible, now), tz };
}
