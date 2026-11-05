import { prisma } from "@/lib/db";
import type { FuelPrice } from "@/lib/eia";

/**
 * Keeps the weekly on-highway diesel price whenever the desk reads it from EIA, so the fuel surcharge summary can set this week against last. The price is public, so it is kept once for every
 * fleet (one row per EIA week and region). Best effort: a failure to keep it never touches the answer the person asked for. There is no scheduler, so the history builds as the price is read.
 */
export async function rememberDiesel(p: Pick<FuelPrice, "fuel" | "period" | "padd" | "pricePerGallon">): Promise<void> {
  if (p.fuel !== "diesel") return;
  const weekOf = p.period.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf) || !(p.pricePerGallon > 0)) return;
  try {
    await prisma.dieselPrice.upsert({ where: { weekOf_region: { weekOf, region: p.padd } }, create: { weekOf, region: p.padd, price: p.pricePerGallon }, update: { price: p.pricePerGallon, fetchedAt: new Date() } });
  } catch {
    /* the history is a convenience */
  }
}
