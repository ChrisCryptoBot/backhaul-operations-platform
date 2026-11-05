/**
 * The three places the radar map looks at: the lower 48, Alaska and Hawaii. Each has a box the camera is held inside (so the land cannot be dragged out of view: a hard stop at the edge) and a
 * box it fits to when the region is chosen. A unit belongs to the region it is in; a search or a clicked row in another region switches the map to it. Pure: the map, the chips and the tests share it.
 * Boxes are `[west, south, east, north]` in degrees.
 */
export type RegionKey = "lower48" | "alaska" | "hawaii";
export type Box = [number, number, number, number];

export const REGIONS: Record<RegionKey, { label: string; clamp: Box; fit: Box }> = {
  lower48: { label: "Lower 48", clamp: [-132, 12, -60, 62], fit: [-125, 24, -66.5, 49.8] },
  // Alaska's box starts at the 180th meridian, the edge of a flat world map (the few Aleutian rocks east of it are not drawn: scripts/build-basemap.mjs). The boxes are deliberately generous in height: a tall map holds more latitude than the region itself, and a box smaller than the view makes MapLibre zoom in until it fits, which would hide part of the land.
  alaska: { label: "Alaska", clamp: [-180, 47, -123, 75], fit: [-170, 51, -129, 71.5] },
  hawaii: { label: "Hawaii", clamp: [-165, 16, -152, 25], fit: [-160.5, 18.7, -154.5, 22.4] }
};
export const REGION_KEYS: RegionKey[] = ["lower48", "alaska", "hawaii"];

/** The longitude as the map places it: a place east of the 180th meridian in the Aleutians is moved west by 360, so it is still known to be Alaska's (it lies beyond the world's edge and is not drawn). */
export const mapLng = (lat: number, lng: number): number => (lng > 0 && lat > 50 ? lng - 360 : lng);

/** Which region a place is in. Anywhere that is neither Alaska nor Hawaii (Canada and Mexico included) is the lower 48's. */
export function regionOf(lat: number, lng: number): RegionKey {
  const x = mapLng(lat, lng);
  if (lat >= 50 && x <= -129) return "alaska";
  if (lat >= 18 && lat <= 23.5 && x >= -161.5 && x <= -154) return "hawaii";
  return "lower48";
}

/** How many of these units are in each region. */
export function regionCounts(points: ReadonlyArray<{ lat: number; lng: number }>): Record<RegionKey, number> {
  const out: Record<RegionKey, number> = { lower48: 0, alaska: 0, hawaii: 0 };
  for (const p of points) out[regionOf(p.lat, p.lng)]++;
  return out;
}

/** The region to open on: the one with the most units (the lower 48 on a tie or with none), so one truck in Anchorage does not stretch the first view across the world. */
export function firstRegion(points: ReadonlyArray<{ lat: number; lng: number }>): RegionKey {
  const c = regionCounts(points);
  let best: RegionKey = "lower48";
  for (const k of REGION_KEYS) if (c[k] > c[best]) best = k;
  return best;
}

/** A box around some points (padded by `pad` degrees, at least `min` wide and tall), in map longitudes. */
export function boxAround(points: ReadonlyArray<{ lat: number; lng: number }>, pad = 1.5, min = 3): Box | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => mapLng(p.lat, p.lng));
  const ys = points.map((p) => p.lat);
  let w = Math.min(...xs) - pad;
  let e = Math.max(...xs) + pad;
  let s = Math.min(...ys) - pad;
  let n = Math.max(...ys) + pad;
  if (e - w < min) {
    const m = (e + w) / 2;
    w = m - min / 2;
    e = m + min / 2;
  }
  if (n - s < min) {
    const m = (n + s) / 2;
    s = m - min / 2;
    n = m + min / 2;
  }
  return [w, s, e, n];
}

/** A box held inside a region's clamp, so a fit can never ask the camera for what it is not allowed to show. */
export function within(box: Box, region: RegionKey): Box {
  const c = REGIONS[region].clamp;
  return [Math.max(box[0], c[0]), Math.max(box[1], c[1]), Math.min(box[2], c[2]), Math.min(box[3], c[3])];
}
