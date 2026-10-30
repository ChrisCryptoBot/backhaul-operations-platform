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
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, eldVehicleId: true } });
  const { provider, result } = await callPartner("eld", null, { vehicles: trucks }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const known = new Map(trucks.map((t) => [t.id, t]));
  let linked = 0;
  let synced = 0;
  await prisma.$transaction(async (tx) => {
    for (const v of result.data.vehicles) {
      const t = known.get(v.id);
      if (!t) continue; // an id this workspace does not have is ignored
      if (v.eldVehicleId && !t.eldVehicleId) linked += 1;
      await tx.vehicle.update({ where: { id: v.id }, data: { eldProvider: provider, eldVehicleId: v.eldVehicleId, hosAvailableHours: v.hosAvailableHours, hosSyncedAt: now } });
      synced += 1;
    }
    const name = providerName(provider);
    if (linked > 0) await recordAudit({ entity: "fleet", action: "eld_linked", summary: `${linked} ${linked === 1 ? "tractor" : "tractors"} linked to ${name}`, before: null, after: { Linked: String(linked) }, at: now, workspaceId }, tx);
    await recordAudit({ entity: "fleet", action: "hos_synced", summary: `Hours of service read for ${synced} ${synced === 1 ? "tractor" : "tractors"} from ${name}`, before: null, after: { Tractors: String(synced) }, at: now, workspaceId }, tx);
  });
  return { ok: true, provider, synced, linked };
}
