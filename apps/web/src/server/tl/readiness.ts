import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { roleOfStop } from "@/lib/stop-role";
import { allowedFor } from "./scope";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { refList, sendReadiness, type SendGap } from "@/lib/send-readiness";

/**
 * What a stored load still lacks before it goes to its driver (see lib/send-readiness.ts). Read from the database so the server decides,
 * whatever the page showed.
 */
export async function loadSendGaps(loadId: string, workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<SendGap[]> {
  const scope = await allowedFor(workspaceId, allowed);
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) }, include: { vehicle: true, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l) return [];
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const pickupRefs = [...refList(l.pickupNumbers), ...l.stops.filter((s) => roleOfStop(s) === "pickup").flatMap((s) => refList(s.referenceNumbers))];
  return sendReadiness({
    weightLbs: l.weightLbs,
    loadNumber: l.loadNumber,
    pickupRefs,
    trailerType: l.trailerType,
    vehicleType: l.vehicle?.type ?? null,
    pickupTime: first?.timeWindowEarliest ?? null,
    deliveryTime: last?.timeWindowEarliest ?? null
  });
}
