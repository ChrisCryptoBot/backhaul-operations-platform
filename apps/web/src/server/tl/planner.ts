import { prisma } from "@/lib/db";
import { buildPlanner, buildWatchlist, planDays, type PlannerLoad } from "@/lib/planner";
import { currentWorkspaceId } from "./workspace";

/** The planner's data: seven Central days from `from`, every active driver's loads by day, the loads still waiting for a driver, and what is due now. */
/** `terminal`: only that terminal's drivers get a row, and loads held by other terminals' drivers are left off; loads nobody holds yet stay for everyone. */
export async function getPlannerData(from: number, now: number = Date.now(), count = 7, workspaceId = currentWorkspaceId(), terminal: string | null = null) {
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
    prisma.driver.findMany({ where: { workspaceId, active: true, ...(terminal ? { terminal } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } })
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
      arrivedAt: s.arrivedAt
    }))
  }));
  const days = days0;
  const inScope = new Set(drivers.map((d) => d.id));
  const visible = terminal ? planner.filter((l) => !l.driverId || inScope.has(l.driverId)) : planner;
  return { days, ...buildPlanner(visible, drivers.map((d) => ({ id: d.id, name: d.name })), days, now), watchlist: buildWatchlist(visible, now) };
}
