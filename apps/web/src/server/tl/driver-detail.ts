import { prisma } from "@/lib/db";
import { driverScorecard, type ScoreLoad } from "@/lib/driver-scorecard";
import { num, numOrNull } from "./convert";
import { driverBlocker } from "./dispatch";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * One driver: who they are and whether they can take a load, what they are on now, and how they have done on the loads they delivered
 * (see lib/driver-scorecard.ts). A TONU is not a delivery and is left out of the scorecard.
 */
const OPEN_ASSIGNMENT = ["draft", "dispatched", "accepted", "in_progress"];
const OPEN_LOAD = ["draft", "accepted", "in_progress"];
const RECENT = 8;

export async function getDriverDetail(id: string, workspaceId = DEMO_WORKSPACE_ID) {
  const d = await prisma.driver.findFirst({
    where: { id, workspaceId },
    include: { assignedVehicle: true, assignments: { include: { load: { include: { stops: { orderBy: { stopSequence: "asc" } } } } }, orderBy: { updatedAt: "desc" } } }
  });
  if (!d) return null;
  const live = d.assignments.filter((a) => a.load.deletedAt == null && a.load.status !== "quote");
  const delivered: ScoreLoad[] = live
    .filter((a) => a.load.status === "completed" && a.status === "completed")
    .map((a) => ({
      id: a.load.id,
      loadNumber: a.load.loadNumber,
      lane: `${a.load.originAddress ?? "?"} → ${a.load.destinationAddress ?? "?"}`,
      completedAt: a.load.completedAt,
      stops: a.load.stops.map((s) => ({ earliest: s.timeWindowEarliest, latest: s.timeWindowLatest, arrivedAt: s.arrivedAt })),
      loadedMiles: num(a.load.loadedMiles),
      pickupDeadheadMiles: num(a.load.pickupDeadheadMiles),
      returnDeadheadMiles: num(a.load.returnDeadheadMiles),
      isBackhaul: a.load.isBackhaul,
      payEstimate: numOrNull(a.payEstimate),
      invoicedAmount: numOrNull(a.load.invoicedAmount),
      paidAmount: numOrNull(a.load.paidAmount),
      paymentStatus: a.load.paymentStatus
    }));
  const scorecard = driverScorecard(delivered);
  return {
    driver: d,
    blocker: driverBlocker(d),
    scorecard,
    recent: [...scorecard.perLoad].sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)).slice(0, RECENT),
    open: live
      .filter((a) => OPEN_ASSIGNMENT.includes(a.status) && OPEN_LOAD.includes(a.load.status))
      .map((a) => ({ loadId: a.load.id, loadNumber: a.load.loadNumber, lane: `${a.load.originAddress ?? "?"} → ${a.load.destinationAddress ?? "?"}`, status: a.status, pickup: a.load.scheduledDate }))
  };
}

