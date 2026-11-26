import type { DraftDto } from "@/app/(desk)/actions";
import type { QuoteStop, QuoteValues } from "@/lib/quote";
import { toCentralLocal } from "@/lib/zoned";

export type RateConInputDraft = {
  load: {
    brokerName?: string | null;
    brokerMcNumber?: string | null;
    loadNumber?: string | null;
    rateConNumber?: string | null;
    proNumber?: string | null;
    bolNumber?: string | null;
    poNumber?: string | null;
    originAddress?: string | null;
    destinationAddress?: string | null;
    trailerType?: string | null;
    commodity?: string | null;
    pieceCount?: number | null;
    palletCount?: number | null;
    reeferSetTempF?: number | null;
    reeferMinF?: number | null;
    reeferMaxF?: number | null;
    reeferMode?: string | null;
    hazmatClass?: string | null;
    hazmatUnNumber?: string | null;
    hazmatPackingGroup?: string | null;
    hazmatEmergencyPhone?: string | null;
    quotedRevenue?: number | null;
    loadedMiles?: number | null;
    payTermsDays?: number | null;
    paymentTerms?: string | null;
  };
  stops: Array<{
    stopRole?: "pickup" | "delivery" | string;
    addressString?: string | null;
    facilityName?: string | null;
    timeWindowEarliest?: string | Date | null;
    timeWindowLatest?: string | Date | null;
    referenceNumbers?: string[] | null;
    contactPhone?: string | null;
    stopNotes?: string | null;
    zone?: string;
  }>;
  printed?: {
    weightLbs?: number | null;
    commodity?: string | null;
    dockTerms?: string | null;
    detentionFreeMinutes?: number | null;
    detentionHourlyRate?: number | null;
    notes?: string | null;
  } | null;
};

export type RateConToQuoteResult = {
  values: QuoteValues;
  filledCount: number;
  filledFields: string[];
};

const localIso = (v: string | Date | null | undefined, zone?: string): string => {
  if (!v) return "";
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? toCentralLocal(ms, zone) : "";
};

/**
 * Maps a rate confirmation reading into Quote values with zero field loss:
 * money, references (`loadNumber`, `rateConNumber`, `proNumber`, `bolNumber`, `poNumber`),
 * freight specs (`commodity`, `pieceCount`, `palletCount`, reefer, hazmat), dock/detention terms,
 * notes, and every stop's facility, open/close times, contact phone, references, and notes.
 */
export function rateConDraftToQuote(draft: DraftDto | RateConInputDraft, current: QuoteValues, opts: { fileName?: string } = {}): RateConToQuoteResult {
  const load = draft.load;
  const printed = draft.printed;
  const next: QuoteValues = {
    ...current,
    stops: [...current.stops],
    manual: [...current.manual]
  };
  const filledFields: string[] = [];

  const setField = <K extends keyof QuoteValues>(key: K, val: QuoteValues[K], label: string) => {
    if (val !== undefined && val !== "" && val !== current[key]) {
      next[key] = val;
      filledFields.push(label);
    }
  };

  if (load.quotedRevenue != null && load.quotedRevenue > 0) setField("offer", String(load.quotedRevenue), "Offer");
  // Miles the document printed are the contract's: marked as typed, so the road measure that follows fills only the empty miles and never writes over them. With none printed, the
  // map measures them (a mark left from an earlier figure is taken off).
  if (load.loadedMiles != null && load.loadedMiles > 0) {
    setField("loadedMiles", String(load.loadedMiles), "Loaded miles");
    if (!next.manual.includes("loadedMiles")) next.manual.push("loadedMiles");
  } else {
    next.manual = next.manual.filter((m) => m !== "loadedMiles" && m !== "loadedHours");
  }
  if (load.brokerName) setField("broker", load.brokerName, "Customer");
  if (load.brokerMcNumber) setField("brokerMc", load.brokerMcNumber, "Customer MC");
  if (load.loadNumber) setField("loadNumber", load.loadNumber, "Load #");
  const rcNumber = load.rateConNumber ?? load.loadNumber;
  if (rcNumber) setField("rateConNumber", rcNumber, "Rate con #");
  if (load.proNumber) setField("proNumber", load.proNumber, "PRO #");
  if (load.bolNumber) setField("bolNumber", load.bolNumber, "BOL #");
  if (load.poNumber) setField("poNumber", load.poNumber, "PO #");
  if (load.trailerType) setField("trailer", load.trailerType, "Trailer");
  const commodity = load.commodity ?? printed?.commodity;
  if (commodity) setField("commodity", commodity, "Commodity");
  if (load.pieceCount != null && load.pieceCount > 0) setField("pieceCount", String(load.pieceCount), "Pieces");
  if (load.palletCount != null && load.palletCount > 0) setField("palletCount", String(load.palletCount), "Pallets");
  if (printed?.weightLbs != null && printed.weightLbs > 0) setField("weightLbs", String(printed.weightLbs), "Weight");
  if (load.reeferSetTempF != null && Number.isFinite(load.reeferSetTempF)) setField("reeferSetTempF", String(load.reeferSetTempF), "Reefer set temp");
  if (load.reeferMinF != null && Number.isFinite(load.reeferMinF)) setField("reeferMinF", String(load.reeferMinF), "Reefer min");
  if (load.reeferMaxF != null && Number.isFinite(load.reeferMaxF)) setField("reeferMaxF", String(load.reeferMaxF), "Reefer max");
  if (load.reeferMode) setField("reeferMode", load.reeferMode, "Reefer mode");
  if (load.hazmatClass) setField("hazmatClass", load.hazmatClass, "Hazmat class");
  if (load.hazmatUnNumber) setField("hazmatUnNumber", load.hazmatUnNumber, "Hazmat UN #");
  if (load.hazmatPackingGroup) setField("hazmatPackingGroup", load.hazmatPackingGroup, "Packing group");
  if (load.hazmatEmergencyPhone) setField("hazmatEmergencyPhone", load.hazmatEmergencyPhone, "Hazmat emergency phone");
  if (load.payTermsDays != null && load.payTermsDays > 0) setField("payTermsDays", String(load.payTermsDays), "Pay terms");
  if (load.paymentTerms) setField("paymentTerms", load.paymentTerms, "Payment terms text");
  const combinedNotes = [printed?.notes?.trim(), printed?.dockTerms?.trim() ? `Dock terms: ${printed.dockTerms.trim()}` : null].filter(Boolean).join("\n").slice(0, 1000);
  if (combinedNotes) setField("notes", combinedNotes, "Notes & dock terms");
  if (printed?.detentionFreeMinutes != null && printed.detentionFreeMinutes >= 0) {
    setField("detentionFreeMinutes", String(printed.detentionFreeMinutes), "Detention free time");
  }
  if (printed?.detentionHourlyRate != null && printed.detentionHourlyRate > 0) {
    setField("detentionHourlyRate", String(printed.detentionHourlyRate), "Detention hourly rate");
  }
  if (opts.fileName?.trim()) setField("rateConPath", opts.fileName.trim(), "Rate confirmation file");

  // Stops mapping: requires at least one pickup and one delivery
  if (draft.stops && draft.stops.length >= 2) {
    const stops: QuoteStop[] = draft.stops.map((s) => {
      // The time as the document printed it, on the dock's own clock (the reading worked the zone out from the stop): the form shows it as it is on the paper.
      const appointment = localIso(s.timeWindowEarliest, s.zone);
      const appointmentEnd = localIso(s.timeWindowLatest, s.zone);
      const stop: QuoteStop = {
        role: s.stopRole === "delivery" ? "delivery" : "pickup",
        address: s.addressString || "",
        appointment,
        ...(s.zone ? { zone: s.zone } : {})
      };
      if (appointmentEnd && appointmentEnd !== appointment) stop.appointmentEnd = appointmentEnd;
      if (s.facilityName) stop.facility = s.facilityName;
      if (s.contactPhone) stop.contactPhone = s.contactPhone;
      if (s.stopNotes) stop.notes = s.stopNotes;
      if (Array.isArray(s.referenceNumbers) && s.referenceNumbers.length > 0) stop.refs = s.referenceNumbers.join(", ");
      return stop;
    });
    next.stops = stops;
    filledFields.push(`${stops.length} stops`);
  }

  return {
    values: next,
    filledCount: filledFields.length,
    filledFields
  };
}
