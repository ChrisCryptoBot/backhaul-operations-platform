import { parseRateConExtraction, rateConTotal, type RateConExtraction } from "@/truelane/lib/rateCon/types";
import { readEquipment, resolveTrailer } from "@/truelane/lib/rateCon/equipment";

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
  }>;
  /** What else the document prints. Shown for checking; a load has nowhere to keep these yet. */
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

const CENTRAL = new Set(["TX", "OK", "IL", "MO", "TN", "AL", "AR", "LA", "MN", "WI", "IA", "KS", "NE", "MS"]);

function stateOf(address: string | null): string | null {
  const m = address ? [...address.matchAll(/,\s*([A-Z]{2})\b/g)].pop() : null;
  return m ? m[1]! : null;
}

/** "2300 Irving Blvd, Dallas, TX 75207" -> "Dallas, TX". Falls back to the text as printed. */
export function cityState(address: string | null): string | null {
  if (!address) return null;
  const m = /([^,]+),\s*([A-Z]{2})\b/.exec(address.split(",").slice(-2).join(","));
  return m ? `${m[1]!.trim()}, ${m[2]}` : address;
}

/**
 * Local date + time at a stop -> a Date. Assumes standard time (no daylight-saving lookup): Central states are UTC-6,
 * everything else UTC-5. A real build resolves the stop's time zone from its coordinates.
 */
export function stopTime(date: string | null, time: string | null, address: string | null): Date | null {
  if (!date || !time) return null;
  const offset = CENTRAL.has(stateOf(address) ?? "") ? "-06:00" : "-05:00";
  const d = new Date(`${date}T${time}:00${offset}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extractionToLoadDraft(raw: unknown): RateConLoadDraft | null {
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
      const end = s.windowEndTime && s.appointmentType === "window" ? stopTime(s.appointmentDate, s.windowEndTime, s.address) : null;
      const start = stopTime(s.appointmentDate, s.appointmentTime, s.address);
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
        stopNotes: s.instructions
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
