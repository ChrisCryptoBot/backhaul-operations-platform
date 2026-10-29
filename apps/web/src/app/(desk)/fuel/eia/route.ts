import { NextResponse } from "next/server";
import { fuelKindOf } from "@/lib/eia";
import { eiaConfigured, latestFuelPrice } from "@/server/fuel/eia";
import { resolveLaneEiaPadd } from "@/truelane/lib/eiaRegion";

export const dynamic = "force-dynamic";

/**
 * Today's regional fuel price: GET /fuel/eia?fuel=diesel&origin=Dallas, TX&destination=Atlanta, GA. The region is where the lane starts (else
 * where it ends, else the nation). A route handler outside /api, like the geo ones, so it never waits behind a server action; the key stays on
 * the server and nothing is stored. A screen fills a fuel box from this only when someone clicks.
 */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const fuel = fuelKindOf(p.get("fuel"));
  const lane = resolveLaneEiaPadd((p.get("origin") ?? "").slice(0, 200), (p.get("destination") ?? "").slice(0, 200));
  if (!eiaConfigured()) return NextResponse.json({ ok: false, reason: "no_key" });
  const price = await latestFuelPrice(fuel, lane.padd);
  if (!price) return NextResponse.json({ ok: false, reason: "unavailable" });
  return NextResponse.json({ ok: true, ...price }, { headers: { "Cache-Control": "private, max-age=300" } });
}
