import type { DraftDto } from "@/app/(desk)/actions";
import type { QuoteStop, QuoteValues } from "@/lib/quote";
import { toCentralLocal } from "@/lib/zoned";

export type RateConInputDraft = {
  load: {
    brokerName?: string | null;
    brokerMcNumber?: string | null;
    loadNumber?: string | null;
    poNumber?: string | null;
    originAddress?: string | null;
    destinationAddress?: string | null;
    trailerType?: string | null;
    quotedRevenue?: number | null;
    loadedMiles?: number | null;
    payTermsDays?: number | null;
  };
  stops: Array<{
    stopRole?: "pickup" | "delivery" | string;
    addressString?: string | null;
    timeWindowEarliest?: string | Date | null;
  }>;
  printed?: {
    weightLbs?: number | null;
    commodity?: string | null;
  } | null;
};

export type RateConToQuoteResult = {
  values: QuoteValues;
  filledCount: number;
  filledFields: string[];
};

/**
 * Maps a rate confirmation reading into Quote values.
 * Pure and non-destructive: only overrides fields that the rate confirmation provided.
 * Uses the same Central (Dallas) time conversion as the rest of the desk for stop appointments.
 */
export function rateConDraftToQuote(draft: DraftDto | RateConInputDraft, current: QuoteValues): RateConToQuoteResult {
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

  if (load.quotedRevenue != null && load.quotedRevenue > 0) {
    setField("offer", String(load.quotedRevenue), "Offer");
  }
  if (load.loadedMiles != null && load.loadedMiles > 0) {
    setField("loadedMiles", String(load.loadedMiles), "Loaded miles");
  }
  if (load.brokerName) {
    setField("broker", load.brokerName, "Customer");
  }
  if (load.brokerMcNumber) {
    setField("brokerMc", load.brokerMcNumber, "Customer MC");
  }
  if (load.loadNumber) {
    setField("loadNumber", load.loadNumber, "Load #");
  }
  if (load.poNumber) {
    setField("poNumber", load.poNumber, "PO #");
  }
  if (load.trailerType) {
    setField("trailer", load.trailerType, "Trailer");
  }
  if (printed?.weightLbs != null && printed.weightLbs > 0) {
    setField("weightLbs", String(printed.weightLbs), "Weight");
  }
  if (load.payTermsDays != null && load.payTermsDays > 0) {
    setField("payTermsDays", String(load.payTermsDays), "Pay terms");
  }

  // Stops mapping: requires at least one pickup and one delivery
  if (draft.stops && draft.stops.length >= 2) {
    const stops: QuoteStop[] = draft.stops.map((s) => {
      let appointment = "";
      if (s.timeWindowEarliest) {
        const ms = new Date(s.timeWindowEarliest).getTime();
        if (Number.isFinite(ms)) appointment = toCentralLocal(ms);
      }
      return {
        role: s.stopRole === "delivery" ? "delivery" : "pickup",
        address: s.addressString || "",
        appointment
      };
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
