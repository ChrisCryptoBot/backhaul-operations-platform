import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { numOrNull } from "@/server/tl/convert";
import { applyStays } from "@/server/tl/stays";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName, type SimTrip } from "./call";

/**
 * ELD and telematics: link each tractor to the ELD's vehicle, read the hours its driver has left on the clock, and keep where it is and what its engine is doing. The hours are a caution on the
 * Quote (lib/hos-caution.ts), never an input to a verdict. Stored on the truck with the time they were read, so the Quote can say how old they are; every fix is also kept for a week
 * (VehiclePing) so a load can show its breadcrumb, and a trailer hooked to the tractor moves with it.
 */
export type SyncResult = { ok: true; provider: string; synced: number; linked: number } | { ok: false; error: string; code?: string };

const OPEN_LOAD = ["accepted", "in_progress"];
const whole = (n: number) => n - (n % 1);

/**
 * Each tractor's open load as a lane for the simulator: the first and last stops that have a point, and the window between them. A live ELD never reads it. A load already on the road is flagged
 * so the simulator puts it somewhere along the lane. A tractor on no load has none.
 */
async function tripsFor(workspaceId: string, truckIds: string[]): Promise<Map<string, SimTrip>> {
  const out = new Map<string, SimTrip>();
  if (truckIds.length === 0) return out;
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null, vehicleId: { in: truckIds }, status: { in: OPEN_LOAD } },
    select: { vehicleId: true, status: true, stops: { orderBy: { stopSequence: "asc" }, select: { lat: true, lng: true, timeWindowEarliest: true, timeWindowLatest: true } } }
  });
  // A load on the road wins over one waiting to go.
  for (const l of loads.sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1))) {
    if (!l.vehicleId || out.has(l.vehicleId)) continue;
    const placed = l.stops.filter((s) => s.lat != null && s.lng != null);
    const first = placed[0];
    const last = placed[placed.length - 1];
    if (!first || !last || first === last) continue;
    const startsAt = (first.timeWindowEarliest ?? first.timeWindowLatest)?.getTime();
    const endsAt = (last.timeWindowLatest ?? last.timeWindowEarliest)?.getTime();
    if (startsAt == null || endsAt == null) continue;
    out.set(l.vehicleId, { origin: { lat: numOrNull(first.lat)!, lng: numOrNull(first.lng)! }, destination: { lat: numOrNull(last.lat)!, lng: numOrNull(last.lng)! }, startsAt, endsAt, inProgress: l.status === "in_progress" });
  }
  return out;
}

export async function syncEld(now = new Date(), workspaceId = currentWorkspaceId()): Promise<SyncResult> {
  const [trucks, people] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, eldVehicleId: true, vin: true, homeBaseLat: true, homeBaseLng: true } }),
    prisma.driver.findMany({ where: { workspaceId, active: true }, select: { id: true, name: true, eldDriverId: true, assignedVehicleId: true } })
  ]);
  const trips = await tripsFor(workspaceId, trucks.map((t) => t.id));
  const { provider, result } = await callPartner(
    "eld",
    null,
    {
      vehicles: trucks.map((t) => ({ id: t.id, name: t.name, eldVehicleId: t.eldVehicleId, trip: trips.get(t.id) ?? null, home: t.homeBaseLat != null && t.homeBaseLng != null ? { lat: numOrNull(t.homeBaseLat)!, lng: numOrNull(t.homeBaseLng)! } : null })),
      drivers: people.map((d) => ({ id: d.id, name: d.name, eldDriverId: d.eldDriverId, vehicleId: d.assignedVehicleId })),
      asOf: now.getTime()
    },
    workspaceId
  );
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const known = new Map(trucks.map((t) => [t.id, t]));
  const knownDrivers = new Map(people.map((d) => [d.id, d]));
  let linked = 0;
  let synced = 0;
  let located = 0;
  let clocks = 0;
  await prisma.$transaction(
    async (tx) => {
      const pings: Array<{ workspaceId: string; vehicleId: string; lat: number; lng: number; speedMph: number | null; headingDeg: number | null; engine: string | null; at: Date }> = [];
      for (const v of result.data.vehicles) {
        const t = known.get(v.id);
        if (!t) continue; // an id this workspace does not have is ignored
        if (v.eldVehicleId && !t.eldVehicleId) linked += 1;
        const at = v.location ? new Date(v.location.at) : null;
        const fresh = at != null && Number.isFinite(at.getTime());
        const idleSince = fresh && v.engine === "idle" && v.idleMinutes != null ? new Date(at.getTime() - v.idleMinutes * 60_000) : null;
        await tx.vehicle.update({
          where: { id: v.id },
          data: {
            eldProvider: provider,
            eldVehicleId: v.eldVehicleId,
            hosAvailableHours: v.hosAvailableHours,
            hosSyncedAt: now,
            ...(v.vin && !t.vin ? { vin: v.vin } : {}),
            ...(fresh
              ? {
                  lastLat: v.location!.lat,
                  lastLng: v.location!.lng,
                  lastLocatedAt: at,
                  lastSpeedMph: v.speedMph ?? null,
                  lastHeadingDeg: v.headingDeg != null ? whole(v.headingDeg) : null,
                  engineState: v.engine ?? null,
                  idleHoursToday: v.idleHoursToday ?? null,
                  idleSince
                }
              : {})
          }
        });
        if (fresh) pings.push({ workspaceId, vehicleId: v.id, lat: v.location!.lat, lng: v.location!.lng, speedMph: v.speedMph ?? null, headingDeg: v.headingDeg != null ? whole(v.headingDeg) : null, engine: v.engine ?? null, at });
        synced += 1;
        if (fresh) located += 1;
      }
      // A re-read of the same fix writes nothing twice (unique on the tractor and the instant).
      if (pings.length > 0) await tx.vehiclePing.createMany({ data: pings, skipDuplicates: true });
      // Where each tractor has stood and for how long, kept longer than the week of raw fixes (Asset history).
      await applyStays(tx, pings.map((p) => ({ workspaceId: p.workspaceId, vehicleId: p.vehicleId, lat: p.lat, lng: p.lng, speedMph: p.speedMph, engine: p.engine, at: p.at })));
      // A trailer hooked to a tractor is where the tractor is: one statement for the whole fleet.
      await tx.$executeRaw`update trailers t set last_lat = v.last_lat, last_lng = v.last_lng, last_located_at = v.last_located_at from vehicles v where t.current_vehicle_id = v.id and t.workspace_id = ${workspaceId} and t.archived_at is null and v.last_located_at is not null`;
      for (const d of result.data.drivers ?? []) {
        const person = knownDrivers.get(d.id);
        if (!person) continue; // a driver this workspace does not have is ignored
        await tx.driver.update({ where: { id: d.id }, data: { eldDriverId: d.eldDriverId, hosDriveMinutes: d.driveMinutes, hosShiftMinutes: d.shiftMinutes, hosCycleMinutes: d.cycleMinutes, hosSyncedAt: now } });
        clocks += 1;
      }
      const name = providerName(provider);
      if (linked > 0) await recordAudit({ entity: "fleet", action: "eld_linked", summary: `${linked} ${linked === 1 ? "tractor" : "tractors"} linked to ${name}`, before: null, after: { Linked: String(linked) }, at: now, workspaceId }, tx);
      await recordAudit({ entity: "fleet", action: "hos_synced", summary: `Hours of service read for ${synced} ${synced === 1 ? "tractor" : "tractors"}${clocks > 0 ? ` and ${clocks} ${clocks === 1 ? "driver" : "drivers"}` : ""} from ${name}`, before: null, after: { Tractors: String(synced), Drivers: String(clocks), Located: String(located) }, at: now, workspaceId }, tx);
    },
    { timeout: 60_000 }
  );
  return { ok: true, provider, synced, linked };
}
