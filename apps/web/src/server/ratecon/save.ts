import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { RateConLoadDraft } from "./map";
import { currentWorkspace } from "@/server/tl/workspace";
import { recordAudit } from "@/server/tl/audit";
import { freezeLoadSnapshot } from "@/server/tl/snapshot";
import { normalizeMcNumber } from "@/lib/fmcsa";
import { saveStopCoordinates } from "@/server/geo/persist";

/**
 * The review gate. A draft read from a rate confirmation becomes a load only when a person has looked at it and
 * sent it back with `confirmed: true` (and any edits). Nothing here computes a verdict.
 */
export type ReviewedDraft = RateConLoadDraft & {
  confirmed: boolean;
  vehicleId?: string | null;
  /** The file the document came from, kept on the load so it can be found again. */
  fileName?: string | null;
  /** Save even though the desk already has a load with this number from this broker. */
  allowDuplicate?: boolean;
};

/** A load with this number from this broker is already on the desk. Carries it, so the page can link to it. */
export class DuplicateLoadError extends Error {
  constructor(
    message: string,
    readonly loadId: string
  ) {
    super(message);
  }
}

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

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export async function saveReviewedDraft(d: ReviewedDraft) {
  assertSavable(d);
  const ws = await currentWorkspace();
  const number = d.load.loadNumber?.trim();
  if (number && !d.allowDuplicate) {
    const twins = await prisma.load.findMany({ where: { workspaceId: ws.id, deletedAt: null, status: { not: "quote" }, loadNumber: { equals: number, mode: "insensitive" } }, select: { id: true, brokerName: true, status: true } });
    // The same number from a broker that is not named is still the same number: only two different named brokers are two different loads.
    const twin = twins.find((t) => !t.brokerName || !d.load.brokerName || same(t.brokerName, d.load.brokerName));
    if (twin) throw new DuplicateLoadError(`Load ${number}${twin.brokerName ? ` from ${twin.brokerName}` : ""} is already on the desk. Open it, or save this one anyway.`, twin.id);
  }
  const weight = d.printed.weightLbs != null && d.printed.weightLbs > 0 ? new Prisma.Decimal(d.printed.weightLbs).toDecimalPlaces(0).toNumber() : null;
  // What the document says about the dock and anything else, kept where the dispatcher will see it (the load's notes).
  const notes = [d.printed.notes?.trim(), d.printed.dockTerms?.trim() ? `Dock terms: ${d.printed.dockTerms.trim()}` : null].filter(Boolean).join("\n").slice(0, 1000) || null;
  const saved = await prisma.$transaction(async (tx) => {
    const load = await tx.load.create({
    data: {
      workspaceId: ws.id,
      vehicleId: d.vehicleId ?? null,
      channel: d.load.channel,
      status: "draft",
      brokerName: d.load.brokerName,
      // Digits only, as everywhere else: a reviewer who typed "MC 1515" must not leave the load reading "MC MC 1515".
      brokerMcNumber: normalizeMcNumber(d.load.brokerMcNumber),
      loadNumber: d.load.loadNumber,
      poNumber: d.load.poNumber,
      originAddress: d.load.originAddress,
      destinationAddress: d.load.destinationAddress,
      trailerType: d.load.trailerType,
      quotedRevenue: d.load.quotedRevenue!,
      loadedMiles: d.load.loadedMiles ?? 0,
      payTermsDays: d.load.payTermsDays,
      paymentTerms: d.load.paymentTerms,
      stopsCount: d.load.stopsCount,
      pickupNumbers: d.load.pickupNumbers,
      deliveryNumbers: d.load.deliveryNumbers,
      scheduledDate: d.stops[0]?.timeWindowEarliest ?? null,
      weightLbs: weight,
      notes,
      rateConPath: d.fileName?.trim() || null,
      // The document's own detention terms win over the truck's profile for this load (freezing the profile later only fills what is still empty).
      snapshotDetentionRate: d.printed.detentionHourlyRate != null && d.printed.detentionHourlyRate > 0 ? d.printed.detentionHourlyRate : null,
      snapshotFreeGraceMinutes: d.printed.detentionFreeMinutes != null && d.printed.detentionFreeMinutes >= 0 ? d.printed.detentionFreeMinutes : null,
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
    // A truck was chosen, so what it costs is known: freeze the floor and the rest now, as the phone does when a rate confirmation is booked.
    if (d.vehicleId) await freezeLoadSnapshot(tx, load.id, { labour: false });
    await recordAudit(
      {
        entity: "intake",
        action: "rate_con_saved",
        loadId: load.id,
        loadNumber: load.loadNumber,
        workspaceId: ws.id,
        summary: `Read from a rate confirmation${d.load.brokerName ? ` from ${d.load.brokerName}` : ""} and reviewed`,
        after: { Load: load.loadNumber, Customer: d.load.brokerName, Stops: load.stops.length }
      },
      tx
    );
    return load;
  });
  // Coordinates come after the save has committed, and never fail it.
  await saveStopCoordinates(saved.id);
  return saved;
}
