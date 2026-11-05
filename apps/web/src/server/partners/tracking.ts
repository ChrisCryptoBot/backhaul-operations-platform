import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { callPartner, providerName } from "./call";

/**
 * Shipment tracking: share one load's location with a tracking network, or stop. Sharing where a truck is with anyone else is the carrier's choice for THIS load, so it needs an
 * explicit yes in the same call and never follows from anything else. No screen offers it yet; this is the seam. When a network is connected it answers with the link a customer follows,
 * which is said in the load's trail; the network's geofence events come back through the webhook receiver (events.ts) and are said there too.
 */
export type ShareResult = { ok: true; sharing: boolean; shareUrl?: string | null } | { ok: false; error: string; code?: string };

export async function shareLoadLocation(loadId: string, share: boolean, optIn: boolean, workspaceId = currentWorkspaceId(), now = new Date()): Promise<ShareResult> {
  if (share && !optIn) return { ok: false, error: "Sharing a load's location needs the carrier's yes for this load.", code: "bad_request" };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const stops = load.stops.map((s) => ({ sequence: s.stopSequence, role: s.stopRole ?? s.stopType, city: s.addressString.split(",")[0]!.trim(), lat: s.lat == null ? null : num(s.lat), lng: s.lng == null ? null : num(s.lng), opensAt: s.timeWindowEarliest ? s.timeWindowEarliest.toISOString() : null }));
  const { provider, result } = await callPartner("tracking", null, { loadId, share, loadNumber: load.loadNumber, stops }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "Tracking could not be reached.", code: result.code };
  // The link and who it is with are kept on the load so the load page can show them; stopping clears them.
  await prisma.load.update({ where: { id: loadId }, data: result.data.sharing ? { trackingShareUrl: result.data.shareUrl ?? null, trackingProvider: provider, trackingSharedAt: now } : { trackingShareUrl: null, trackingProvider: null, trackingSharedAt: null } });
  await recordAudit({ entity: "load", action: "partner_event", loadId, loadNumber: load.loadNumber, summary: result.data.sharing ? `Location shared with ${providerName(provider)}${result.data.shareUrl ? `, link ${result.data.shareUrl}` : ""}` : `Location sharing with ${providerName(provider)} stopped`, at: now, workspaceId });
  return { ok: true, sharing: result.data.sharing, shareUrl: result.data.shareUrl ?? null };
}
