import { parseRateConExtraction, rateConTotal, type RateConExtraction } from "@/truelane/lib/rateCon/types";
import { readEquipment, resolveTrailer } from "@/truelane/lib/rateCon/equipment";
import { instantInZone } from "@/truelane/lib/rateCon/stopTime";
import { cityState } from "@/lib/city-state";
import { printedLabel, zoneForAddress, type StopZone } from "@/server/geo/zones";

export { cityState };

/**
 * A reviewed-or-not draft of a load planned from a rate confirmation. There is deliberately no verdict here:
 * a rate con is for a load that was already accepted, and the verdict lives in the load's own screen.
 */
export type RateConLoadDraft = {
  load: {
    brokerName: string | null;
    brokerMcNumber: string | null;
    loadNumber: string | null;
    poNumber: string | null;
    originAddress: string | null;
    destinationAddress: string | null;
    trailerType: string | null;
    /** What the document pays all-in. A flat fuel surcharge printed on it is already inside this: see `printed`. */
    quotedRevenue: number | null;
    loadedMiles: number | null;
    payTermsDays: number | null;
    paymentTerms: string | null;
    stopsCount: number;
    pickupNumbers: string[];
    deliveryNumbers: string[];
    channel: "rate_con";
    status: "draft";
  };
  stops: Array<{
    stopSequence: number;
    stopType: "pickup" | "delivery";
    stopRole: "pickup" | "delivery";
    addressString: string;
    facilityName: string | null;
    timeWindowEarliest: Date | null;
    timeWindowLatest: Date | null;
    referenceNumbers: string[];
    contactPhone: string | null;
    stopNotes: string | null;
    /** The time zone the printed times are in (an IANA name) and where it came from. Optional: a draft built by hand has neither. */
    zone?: string;
    zoneSource?: StopZone["source"];
    /** The time as the document printed it, with the stop's own zone ("9:00 AM ET"), for the review. */
    printed?: string | null;
  }>;
  /** What else the document prints. Shown for checking. Weight, the notes and dock terms, and the detention terms are saved on the load; the commodity is shown only. */
  printed: {
    commodity: string | null;
    weightLbs: number | null;
    /**
     * The flat fuel surcharge inside the all-in rate, if one was printed. It is not saved on the load: the load's own surcharge field
     * is a per-mile or percent rate, and saving a flat amount there would count it twice.
     */
    fuelSurchargeIncluded: number | null;
    /** Detention and TONU wording as printed, with the free time and hourly rate when they were read. */
    dockTerms: string | null;
    detentionFreeMinutes: number | null;
    detentionHourlyRate: number | null;
    notes: string | null;
    /** The document pays only a TONU fee: nothing was hauled. */
    tonuOnly: boolean;
  };
  /** What the reader was unsure of, plus what the mapper could not fill. Shown on the review sheet. */
  warnings: string[];
};

/**
 * Local date + time at a stop, in the stop's zone -> the instant it means. Daylight saving is the zone's own (an Eastern stop in July is
 * UTC-4); the zone comes from the stop's coordinates or state (see geo/zones.ts), never a fixed offset.
 */
export function stopTime(date: string | null, time: string | null, zone: string): Date | null {
  if (!date || !time) return null;
  const ms = instantInZone(date, time, zone);
  return ms == null ? null : new Date(ms);
}

/** `zones` are each stop's zone in order, when they were looked up; a stop without one is placed by its state (so this stays pure and needs no network). */
export function extractionToLoadDraft(raw: unknown, zones?: Array<StopZone | undefined>): RateConLoadDraft | null {
  const x: RateConExtraction | null = parseRateConExtraction(raw);
  if (!x) return null;
  const warnings = [...x.warnings];
  const pickups = x.stops.filter((s) => s.type === "pickup");
  const deliveries = x.stops.filter((s) => s.type === "delivery");
  if (pickups.length === 0) warnings.push("No pickup was read from this document.");
  if (deliveries.length === 0) warnings.push("No delivery was read from this document.");
  const first = x.stops[0];
  const last = x.stops[x.stops.length - 1];
  const trailer = resolveTrailer(readEquipment(x.equipment)).trailer;
  // A missing rate is not a warning here: the review page asks for it and clears the ask as soon as one is typed.
  const total = rateConTotal(x);

  return {
    load: {
      brokerName: x.broker.name,
      brokerMcNumber: x.broker.mcNumber,
      loadNumber: x.loadNumber,
      poNumber: x.poNumber,
      originAddress: cityState(first?.address ?? null),
      destinationAddress: cityState(last?.address ?? null),
      trailerType: trailer,
      quotedRevenue: total,
      loadedMiles: x.milesPrinted,
      payTermsDays: x.paymentTermsDays,
      paymentTerms: x.paymentTermsText,
      stopsCount: x.stops.length,
      pickupNumbers: pickups.flatMap((s) => s.referenceNumbers),
      deliveryNumbers: deliveries.flatMap((s) => s.referenceNumbers),
      channel: "rate_con",
      status: "draft"
    },
    stops: x.stops.map((s, i) => {
      const where = zones?.[i] ?? zoneForAddress(s.address);
      const end = s.windowEndTime && s.appointmentType === "window" ? stopTime(s.appointmentDate, s.windowEndTime, where.zone) : null;
      const start = stopTime(s.appointmentDate, s.appointmentTime, where.zone);
      return {
        stopSequence: i + 1,
        stopType: s.type,
        stopRole: s.type,
        addressString: s.address ?? "",
        facilityName: s.name,
        timeWindowEarliest: start,
        timeWindowLatest: end ?? start,
        referenceNumbers: s.referenceNumbers,
        contactPhone: s.contactPhone,
        stopNotes: s.instructions,
        zone: where.zone,
        zoneSource: where.source,
        printed: printedLabel(s.appointmentTime, s.appointmentType === "window" ? s.windowEndTime : null, where.zone)
      };
    }),
    printed: {
      commodity: x.commodity,
      weightLbs: x.weightLbs,
      fuelSurchargeIncluded: x.rate.fuelSurcharge,
      dockTerms: x.detentionTerms,
      detentionFreeMinutes: x.detention.freeMinutes,
      detentionHourlyRate: x.detention.hourlyRate,
      notes: x.notes,
      tonuOnly: x.tonuOnly
    },
    warnings
  };
}
