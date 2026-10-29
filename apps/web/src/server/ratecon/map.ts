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
    quotedRevenue: number | null;
    fuelSurcharge: number | null;
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
  if (pickups.length === 0) warnings.push("No pickup was read: add one before saving.");
  if (deliveries.length === 0) warnings.push("No delivery was read: add one before saving.");
  const first = x.stops[0];
  const last = x.stops[x.stops.length - 1];
  const trailer = resolveTrailer(readEquipment(x.equipment)).trailer;
  const total = rateConTotal(x);
  if (total == null) warnings.push("No rate was read: type the agreed rate.");

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
      fuelSurcharge: x.rate.fuelSurcharge,
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
    warnings
  };
}
