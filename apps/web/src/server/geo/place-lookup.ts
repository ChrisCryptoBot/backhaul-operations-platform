import { geocode } from "./mapbox";
import { findPlace, type Found } from "@/lib/gazetteer/place-index";

/**
 * Where a typed ZIP, city or state is: the bundled Census data first (instant, free, offline), and only text it cannot read (a street address, an odd spelling, a place outside the data) goes to the
 * metered geocoder, which is guarded by the desk's spend ceilings and answers nothing without a key. The map search uses this; it never stores what it finds.
 */
export async function lookupPlace(text: string): Promise<(Found & { source: "census" | "mapbox" }) | null> {
  const t = text.trim();
  if (t.length < 2) return null;
  const hit = findPlace(t);
  if (hit) return { ...hit, source: "census" };
  const far = await geocode(t);
  return far ? { kind: "city", label: far.label, lat: far.lat, lng: far.lng, defaultRadius: null, source: "mapbox" } : null;
}
