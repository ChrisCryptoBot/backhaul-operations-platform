import { prisma } from "@/lib/db";
import { refList, sendReadiness, type SendGap } from "@/lib/send-readiness";

/**
 * What a stored load still lacks before it goes to its driver (see lib/send-readiness.ts). Read from the database so the server decides,
 * whatever the page showed.
 */
export async function loadSendGaps(loadId: string): Promise<SendGap[]> {
  const l = await prisma.load.findUnique({ where: { id: loadId }, include: { vehicle: true, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l) return [];
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const pickupRefs = [...refList(l.pickupNumbers), ...l.stops.filter((s) => s.stopRole === "pickup").flatMap((s) => refList(s.referenceNumbers))];
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
