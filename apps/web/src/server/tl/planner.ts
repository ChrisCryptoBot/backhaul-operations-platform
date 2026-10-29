import { prisma } from "@/lib/db";
import { buildPlanner, buildWatchlist, planDays, type PlannerLoad } from "@/lib/planner";
import { DEMO_WORKSPACE_ID } from "./workspace";

/** The planner's data: seven Central days from `from`, every active driver's loads by day, the loads still waiting for a driver, and what is due now. */
export async function getPlannerData(from: number, now: number = Date.now(), count = 7, workspaceId = DEMO_WORKSPACE_ID) {
  const [loads, drivers] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, status: { in: ["draft", "accepted", "in_progress", "completed"] } },
      include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: { include: { driver: true } } }
    }),
    prisma.driver.findMany({ where: { workspaceId, active: true }, orderBy: { name: "asc" } })
  ]);
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
  const days = planDays(from, count, now);
  return { days, ...buildPlanner(planner, drivers.map((d) => ({ id: d.id, name: d.name })), days, now), watchlist: buildWatchlist(planner, now) };
}
