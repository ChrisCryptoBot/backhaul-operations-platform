import { EIA_URL, eiaQuery, parseEiaPrice, type FuelKind, type FuelPrice } from "@/lib/eia";
import type { EiaPadd } from "@/truelane/lib/eiaRegion";

/**
 * The latest weekly EIA fuel price for a region, server side (the key never reaches the browser). EIA publishes once a week, so an answer is
 * remembered for six hours. If a region has no price the national one is returned and flagged, as the phone does. Every failure (no key, a
 * timeout, a bad answer) reads as null and is never remembered. The screens fill a fuel box from this only when someone asks.
 */
const TIMEOUT_MS = 8000;
const MEMORY_MS = 6 * 60 * 60 * 1000;
const memory = new Map<string, { at: number; price: FuelPrice }>();

export const clearEiaMemory = () => memory.clear();

export type LivePrice = FuelPrice & { nationalFallback: boolean };

async function fetchPrice(fuel: FuelKind, padd: EiaPadd, fetchImpl: typeof fetch, apiKey: string): Promise<FuelPrice | null> {
  const slot = `${fuel}:${padd}`;
  const hit = memory.get(slot);
  if (hit && Date.now() - hit.at < MEMORY_MS) return hit.price;
  try {
    const res = await fetchImpl(`${EIA_URL}?${eiaQuery(apiKey, fuel, padd).toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return null;
    const price = parseEiaPrice(await res.json(), fuel, padd);
    if (price) memory.set(slot, { at: Date.now(), price });
    return price;
  } catch {
    return null;
  }
}

export const eiaConfigured = (): boolean => (process.env.EIA_API_KEY ?? "").trim() !== "";

export async function latestFuelPrice(fuel: FuelKind, padd: EiaPadd, fetchImpl: typeof fetch = fetch, apiKey: string = process.env.EIA_API_KEY ?? ""): Promise<LivePrice | null> {
  const key = apiKey.trim();
  if (!key) return null;
  const regional = await fetchPrice(fuel, padd, fetchImpl, key);
  if (regional) return { ...regional, nationalFallback: false };
  if (padd === "NUS") return null;
  const national = await fetchPrice(fuel, "NUS", fetchImpl, key);
  return national ? { ...national, nationalFallback: true } : null;
}
