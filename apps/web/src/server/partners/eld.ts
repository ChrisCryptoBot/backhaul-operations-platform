import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName } from "./call";

/**
 * ELD and telematics: link each tractor to the ELD's vehicle and read the hours its driver has left on the clock. The hours are a caution on the Quote (lib/hos-caution.ts),
 * never an input to a verdict. Stored on the truck with the time they were read, so the Quote can say how old they are.
 */
export type SyncResult = { ok: true; provider: string; synced: number; linked: number } | { ok: false; error: string; code?: string };

export async function syncEld(now = new Date(), workspaceId = currentWorkspaceId()): Promise<SyncResult> {
  const [trucks, people] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, eldVehicleId: true } }),
    prisma.driver.findMany({ where: { workspaceId, active: true }, select: { id: true, name: true, eldDriverId: true, assignedVehicleId: true } })
  ]);
  const { provider, result } = await callPartner("eld", null, { vehicles: trucks, drivers: people.map((d) => ({ id: d.id, name: d.name, eldDriverId: d.eldDriverId, vehicleId: d.assignedVehicleId })) }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const known = new Map(trucks.map((t) => [t.id, t]));
  const knownDrivers = new Map(people.map((d) => [d.id, d]));
  let linked = 0;
  let synced = 0;
  let located = 0;
  let clocks = 0;
  await prisma.$transaction(async (tx) => {
    for (const v of result.data.vehicles) {
      const t = known.get(v.id);
      if (!t) continue; // an id this workspace does not have is ignored
      if (v.eldVehicleId && !t.eldVehicleId) linked += 1;
      const at = v.location ? new Date(v.location.at) : null;
      const fresh = at != null && Number.isFinite(at.getTime());
      await tx.vehicle.update({
        where: { id: v.id },
        data: { eldProvider: provider, eldVehicleId: v.eldVehicleId, hosAvailableHours: v.hosAvailableHours, hosSyncedAt: now, ...(fresh ? { lastLat: v.location!.lat, lastLng: v.location!.lng, lastLocatedAt: at } : {}) }
      });
      synced += 1;
      if (fresh) located += 1;
    }
    for (const d of result.data.drivers ?? []) {
      const person = knownDrivers.get(d.id);
      if (!person) continue; // a driver this workspace does not have is ignored
      await tx.driver.update({ where: { id: d.id }, data: { eldDriverId: d.eldDriverId, hosDriveMinutes: d.driveMinutes, hosShiftMinutes: d.shiftMinutes, hosCycleMinutes: d.cycleMinutes, hosSyncedAt: now } });
      clocks += 1;
    }
    const name = providerName(provider);
    if (linked > 0) await recordAudit({ entity: "fleet", action: "eld_linked", summary: `${linked} ${linked === 1 ? "tractor" : "tractors"} linked to ${name}`, before: null, after: { Linked: String(linked) }, at: now, workspaceId }, tx);
    await recordAudit({ entity: "fleet", action: "hos_synced", summary: `Hours of service read for ${synced} ${synced === 1 ? "tractor" : "tractors"}${clocks > 0 ? ` and ${clocks} ${clocks === 1 ? "driver" : "drivers"}` : ""} from ${name}`, before: null, after: { Tractors: String(synced), Drivers: String(clocks), Located: String(located) }, at: now, workspaceId }, tx);
  });
  return { ok: true, provider, synced, linked };
}
