import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner } from "./call";

/**
 * Shipment tracking: share one load's location with a tracking network, or stop. Sharing where a truck is with anyone else is the carrier's choice for THIS load, so it needs an
 * explicit yes in the same call and never follows from anything else. No screen offers it yet; this is the seam, answering `not_connected` until a company is chosen.
 */
export type ShareResult = { ok: true; sharing: boolean } | { ok: false; error: string; code?: string };

export async function shareLoadLocation(loadId: string, share: boolean, optIn: boolean, workspaceId = currentWorkspaceId()): Promise<ShareResult> {
  if (share && !optIn) return { ok: false, error: "Sharing a load's location needs the carrier's yes for this load.", code: "bad_request" };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const { result } = await callPartner("tracking", null, { loadId, share }, workspaceId);
  return result.ok ? { ok: true, sharing: result.data.sharing } : { ok: false, error: result.message ?? "Tracking could not be reached.", code: result.code };
}
