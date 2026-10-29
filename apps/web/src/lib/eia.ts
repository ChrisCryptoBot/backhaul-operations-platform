/**
 * The weekly on-highway fuel price from the U.S. Energy Information Administration. The request and the series are TrueLane's (its lib/eia.ts
 * cannot be vendored: it keeps its cache in the phone's storage); the region comes from the vendored eiaRegion. Pure, so it is tested without a
 * key. The server module (server/fuel/eia.ts) makes the call; the screens only ever fill a box from it when someone asks.
 */
import { EIA_PADD_LABELS, type EiaPadd } from "@/truelane/lib/eiaRegion";

export type FuelKind = "diesel" | "gasoline";

export const EIA_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";

/** On-highway diesel and regular gasoline, weekly retail (petroleum/pri/gnd), by region. Not the heating-oil series. */
export const EIA_SERIES: Record<FuelKind, Record<EiaPadd, string>> = {
  diesel: {
    NUS: "EMD_EPD2D_PTE_NUS_DPG",
    R10: "EMD_EPD2D_PTE_R10_DPG",
    R20: "EMD_EPD2D_PTE_R20_DPG",
    R30: "EMD_EPD2D_PTE_R30_DPG",
    R40: "EMD_EPD2D_PTE_R40_DPG",
    R50: "EMD_EPD2D_PTE_R50_DPG"
  },
  gasoline: {
    NUS: "EMM_EPMR_PTE_NUS_DPG",
    R10: "EMM_EPMR_PTE_R10_DPG",
    R20: "EMM_EPMR_PTE_R20_DPG",
    R30: "EMM_EPMR_PTE_R30_DPG",
    R40: "EMM_EPMR_PTE_R40_DPG",
    R50: "EMM_EPMR_PTE_R50_DPG"
  }
};

/** A truck's fuel type as the price to ask for: gasoline only when it says so; a truck with no fuel type is read as diesel, the common case. */
export const fuelKindOf = (fuelType: string | null | undefined): FuelKind => ((fuelType ?? "").trim().toLowerCase() === "gasoline" ? "gasoline" : "diesel");

/** The request's query string, parameter for parameter as the phone sends it. The key is the caller's; it is never logged. */
export function eiaQuery(apiKey: string, fuel: FuelKind, padd: EiaPadd): URLSearchParams {
  return new URLSearchParams({
    api_key: apiKey.trim(),
    frequency: "weekly",
    "data[0]": "value",
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: "1",
    "facets[series][]": EIA_SERIES[fuel][padd]
  });
}

export type FuelPrice = { pricePerGallon: number; period: string; padd: EiaPadd; regionLabel: string; fuel: FuelKind };

/** The latest weekly price in an answer, or null when it is missing, not a number, or not above zero. */
export function parseEiaPrice(json: unknown, fuel: FuelKind, padd: EiaPadd): FuelPrice | null {
  const data = (json as { response?: { data?: Array<{ period?: unknown; value?: unknown }> } } | null)?.response?.data;
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || first.value == null || !first.period) return null;
  const value = Number(first.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { pricePerGallon: value, period: String(first.period), padd, regionLabel: EIA_PADD_LABELS[padd], fuel };
}

export type FuelFill = { action: "fill" } | { action: "same" } | { action: "ask"; typed: string };

/**
 * What a "use today's price" click should do to a fuel box. An empty box is filled. A box already holding that price (to the cent) is left.
 * A box holding anything else is never replaced silently: the screen shows both numbers and asks. Typed text that is not a number counts as
 * typed, so it is asked about too.
 */
export function decideFuelFill(typed: string, live: number): FuelFill {
  const text = typed.trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return { action: "fill" };
  const n = Number(text);
  if (Number.isFinite(n) && Math.abs(n - live) < 0.005) return { action: "same" };
  return { action: "ask", typed: typed.trim() };
}

/** "week of Oct 26" from EIA's period date ("2026-10-26"). */
export function weekOf(period: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (!m) return period;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `week of ${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}
