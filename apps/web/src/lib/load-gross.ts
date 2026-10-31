import { loadGross } from "@/truelane/lib/domain/loadEconomics";

/**
 * What a load earned, the same on every screen: the linehaul actually paid when one was entered, else the agreed rate, plus the fuel surcharge and any layover pay; a TONU is its
 * fee; a cancelled load earned nothing. TrueLane's own sum (loadEconomics.loadGross), so the board, History, the load page, the exports and the KPI cannot disagree. Detention, lumper and
 * the like are billed on the invoice as extras and are shown beside this, not inside it.
 */
export type GrossInput = { status: string; quotedRevenue: number; actualRevenue: number | null; fuelSurcharge: number | null; layoverPay: number | null; tonuRevenue: number | null };

export function grossOf(l: GrossInput): number {
  if (l.status === "cancelled" || l.status === "quote") return 0;
  return Math.round(loadGross(l) * 100) / 100;
}
