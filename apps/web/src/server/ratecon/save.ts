import { prisma } from "@/lib/db";
import type { RateConLoadDraft } from "./map";
import { currentWorkspace } from "@/server/tl/workspace";

/**
 * The review gate. A draft read from a rate confirmation becomes a load only when a person has looked at it and
 * sent it back with `confirmed: true` (and any edits). Nothing here computes a verdict.
 */
export type ReviewedDraft = RateConLoadDraft & { confirmed: boolean; vehicleId?: string | null };

export class ReviewRequiredError extends Error {
  constructor() {
    super("A rate confirmation has to be reviewed before it becomes a load.");
  }
}

export function assertSavable(d: ReviewedDraft): void {
  if (!d.confirmed) throw new ReviewRequiredError();
  if (d.load.quotedRevenue == null || d.load.quotedRevenue <= 0) throw new Error("Type the agreed rate before saving.");
  if (d.stops.length === 0) throw new Error("A load needs at least one stop.");
}

export async function saveReviewedDraft(d: ReviewedDraft) {
  assertSavable(d);
  const ws = await currentWorkspace();
  return prisma.load.create({
    data: {
      workspaceId: ws.id,
      vehicleId: d.vehicleId ?? null,
      channel: d.load.channel,
      status: "draft",
      brokerName: d.load.brokerName,
      brokerMcNumber: d.load.brokerMcNumber,
      loadNumber: d.load.loadNumber,
      poNumber: d.load.poNumber,
      originAddress: d.load.originAddress,
      destinationAddress: d.load.destinationAddress,
      trailerType: d.load.trailerType,
      quotedRevenue: d.load.quotedRevenue!,
      fuelSurcharge: d.load.fuelSurcharge,
      loadedMiles: d.load.loadedMiles ?? 0,
      payTermsDays: d.load.payTermsDays,
      paymentTerms: d.load.paymentTerms,
      stopsCount: d.load.stopsCount,
      pickupNumbers: d.load.pickupNumbers,
      deliveryNumbers: d.load.deliveryNumbers,
      scheduledDate: d.stops[0]?.timeWindowEarliest ?? null,
      stops: {
        create: d.stops.map((s) => ({
          stopSequence: s.stopSequence,
          stopType: s.stopType,
          stopRole: s.stopRole,
          addressString: s.addressString,
          facilityName: s.facilityName,
          timeWindowEarliest: s.timeWindowEarliest,
          timeWindowLatest: s.timeWindowLatest,
          referenceNumbers: s.referenceNumbers,
          contactPhone: s.contactPhone,
          stopNotes: s.stopNotes
        }))
      }
    },
    include: { stops: true }
  });
}
