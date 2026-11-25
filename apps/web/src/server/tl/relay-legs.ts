import type { Prisma } from "@prisma/client";
import { positioningPayEstimate, type MilesSource } from "@/lib/relay";
import { numOrNull } from "./convert";

/**
 * The write side of legs that both the dispatch code and the relay code need, kept apart so neither imports the other (docs/RELAY_DESIGN.md). It imports nothing from the desk's server code.
 * A load that never relays has no leg rows: it is one implicit leg, the assignment. The first handoff or an empty recall writes leg 1 from the assignment as it stood.
 */
type Tx = Prisma.TransactionClient;

type LoadForLeg = {
  id: string;
  workspaceId: string;
  vehicleId: string | null;
  vehicle: { name: string | null } | null;
  trailerId: string | null;
  trailer: { number: string } | null;
  stops: Array<{ addressString: string | null; lat: unknown; lng: unknown; arrivedAt: Date | null }>;
};
type AssignmentForLeg = {
  driverId: string;
  driver: { name: string };
  payKind: string;
  payRate: unknown;
  payEstimate: unknown;
};

const num = (v: unknown): number | null => numOrNull(v as never);

/** The legs a load has so far, oldest first. */
export const legsOf = (tx: Tx, loadId: string) => tx.loadLeg.findMany({ where: { loadId }, orderBy: { seq: "asc" } });

/** The load's active leg, writing leg 1 from the assignment as it stands when the load has none yet. */
export async function ensureActiveLeg(tx: Tx, load: LoadForLeg, a: AssignmentForLeg, now: Date) {
  const legs = await legsOf(tx, load.id);
  const active = legs.find((l) => l.status === "active");
  if (active) return active;
  // When closed legs (e.g. a positioning recall) already exist, open the next haul leg with seq = max + 1 rather than throwing or colliding with seq 1.
  const seq = legs.reduce((max, l) => (l.seq > max ? l.seq : max), 0) + 1;
  const first = load.stops[0];
  return tx.loadLeg.create({
    data: {
      workspaceId: load.workspaceId,
      loadId: load.id,
      seq,
      kind: "haul",
      status: "active",
      driverId: a.driverId,
      driverName: a.driver.name,
      vehicleId: load.vehicleId,
      vehicleName: load.vehicle?.name ?? null,
      trailerId: load.trailerId,
      trailerNumber: load.trailer?.number ?? null,
      fromName: first?.addressString ?? null,
      fromLat: num(first?.lat) as never,
      fromLng: num(first?.lng) as never,
      startedAt: first?.arrivedAt ?? now
    }
  });
}

/**
 * A driver taken off a load while rolling empty to the pickup: there is no freight to hand over, so no baton. The leg is kept as positioning, closed, with the miles driven and where the figure
 * came from (never a guess: with no miles the leg says so and the pay stays unknown), and the pay is the driver's own cents a mile times those miles (sign-off 1: standard CPM for deadhead miles).
 */
export async function writePositioningLeg(
  tx: Tx,
  load: LoadForLeg,
  a: AssignmentForLeg & { driver: { name: string; defaultPayKind: string | null; defaultPayRate: unknown } },
  i: { milesDriven: number | null; milesSource: MilesSource | null; now: Date }
) {
  const legs = await legsOf(tx, load.id);
  const seq = (legs.at(-1)?.seq ?? 0) + 1;
  // Their standard cents a mile: the rate on this assignment when it is per mile, else the rate on their record when that is per mile, else unknown.
  const cpm = a.payKind === "cpm" ? num(a.payRate) : a.driver.defaultPayKind === "cpm" ? num(a.driver.defaultPayRate) : null;
  const first = load.stops[0];
  return tx.loadLeg.create({
    data: {
      workspaceId: load.workspaceId,
      loadId: load.id,
      seq,
      kind: "positioning",
      status: "closed",
      driverId: a.driverId,
      driverName: a.driver.name,
      vehicleId: load.vehicleId,
      vehicleName: load.vehicle?.name ?? null,
      trailerId: load.trailerId,
      trailerNumber: load.trailer?.number ?? null,
      toName: first?.addressString ?? null,
      endedAt: i.now,
      milesDriven: (i.milesDriven ?? null) as never,
      milesSource: i.milesDriven != null ? i.milesSource : null,
      payKind: cpm != null ? "cpm" : null,
      payRate: (cpm ?? null) as never,
      payEstimate: positioningPayEstimate(i.milesDriven, cpm) as never
    }
  });
}
