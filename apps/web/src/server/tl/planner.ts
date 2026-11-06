import { terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { buildPlanner, buildWatchlist, planDays, type PlannerLoad } from "@/lib/planner";
import { currentWorkspaceId } from "./workspace";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { activeTz } from "@/lib/tz";
import { dateKeyOf } from "@/lib/shifts";
import { loadSchedules } from "./shifts";
import { workspaceTimezone } from "./zone";

/** The planner's data: seven Central days from `from`, every active driver's loads by day, the loads still waiting for a driver, and what is due now. */
/** `terminal`: only that terminal's home drivers get a row, and loads held by drivers based elsewhere are left off (their number is `hiddenElsewhere`, so the page can offer to include them); loads nobody holds yet stay for everyone. */
export async function getPlannerData(from: number, now: number = Date.now(), count = 7, workspaceId = currentWorkspaceId(), terminal: Terminals = null) {
  // Only what the board can show: every open load (they are the commitments, and the ones with no times are listed beside the grid) and the delivered loads
  // that fall in or near the days shown. A fleet has tens of thousands of finished loads, none of which belong on this week.
  const days0 = planDays(from, count, now);
  const near = { gte: new Date(days0[0]!.start - 2 * 86_400_000), lte: new Date(days0[days0.length - 1]!.end + 2 * 86_400_000) };
  // The loads are named first, by two cheap lookups, and only those are read in full: the open ones (an index) and the delivered ones with a stop in the days shown
  // (one pass over the stops). Asking for both at once, as one query, made the database test every load against every stop.
  const [named, drivers] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      select id from loads where workspace_id = ${workspaceId} and deleted_at is null and status in ('draft', 'accepted', 'in_progress')
      union
      select l.id from loads l join stops s on s.load_id = l.id
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed'
        and ((s.time_window_earliest >= ${near.gte} and s.time_window_earliest <= ${near.lte}) or (s.time_window_latest >= ${near.gte} and s.time_window_latest <= ${near.lte}))`,
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
  const inScope = new Set(drivers.map((d) => d.id));
  const visible = terminal ? planner.filter((l) => !l.driverId || inScope.has(l.driverId)) : planner;
  // Shifts are the carrier's clock (the workspace's zone); a column is matched to them by the instants it spans, so a desk reading another clock still lines up.
  const tz = await workspaceTimezone(workspaceId);
  const schedules = await loadSchedules(workspaceId, drivers.map((d) => d.id), dateKeyOf(days[0]!.start, tz), dateKeyOf(days[days.length - 1]!.end, tz));
  const shownIds = new Set(visible.map((l) => l.id));
  const hiddenElsewhere = terminal ? planner.filter((l) => !shownIds.has(l.id)).length : 0;
  return { days, hiddenElsewhere, ...buildPlanner(visible, drivers.map((d) => ({ id: d.id, name: d.name, code: d.code })), days, now, { schedules, tz }), watchlist: buildWatchlist(visible, now), tz };
}
