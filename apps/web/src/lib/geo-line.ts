/**
 * Small pure helpers for points on a line: where along a lane a truck is, which way it is heading, how far a point is from a polyline. Flat-earth maths on the continental US, good to a
 * fraction of a percent over a lane, and never used to price or route a mile (that is the measured road distance, src/server/geo).
 */
export type LatLng = { lat: number; lng: number };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const MILES_PER_DEG_LAT = 69.0;

/** The point a fraction (0 to 1) of the way from `a` to `b`. */
export function interpolate(a: LatLng, b: LatLng, f: number): LatLng {
  const t = Math.min(1, Math.max(0, f));
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Compass bearing in whole degrees (0 north, 90 east) from `a` to `b`. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (Math.round(deg(Math.atan2(y, x))) + 360) % 360;
}

/** "N", "NE", ... for a heading. */
export function compass(heading: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((heading % 360) + 360) % 360) / 45) % 8]!;
}

/** Local flat coordinates in miles around a reference latitude. */
const flat = (p: LatLng, refLat: number) => ({ x: p.lng * Math.cos(rad(refLat)) * MILES_PER_DEG_LAT, y: p.lat * MILES_PER_DEG_LAT });

/** The share (0 to 1) of the way along a to b that `p` projects onto, and how far off the line it sits in miles. */
export function projectOnLine(a: LatLng, b: LatLng, p: LatLng): { fraction: number; offMiles: number } {
  const ref = (a.lat + b.lat) / 2;
  const A = flat(a, ref);
  const B = flat(b, ref);
  const P = flat(p, ref);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const raw = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  const f = Math.min(1, Math.max(0, raw));
  const cx = A.x + dx * f;
  const cy = A.y + dy * f;
  return { fraction: f, offMiles: Math.hypot(P.x - cx, P.y - cy) };
}

/** Miles from a point to the nearest part of a polyline of [lng, lat] pairs, and the compass bearing of the stretch it is nearest. */
export function nearestOnPolyline(p: LatLng, coords: ReadonlyArray<readonly [number, number]>): { miles: number; bearing: number } | null {
  if (coords.length < 2) return null;
  let best: { miles: number; bearing: number } | null = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = { lat: coords[i]![1], lng: coords[i]![0] };
    const b = { lat: coords[i + 1]![1], lng: coords[i + 1]![0] };
    const { offMiles } = projectOnLine(a, b, p);
    if (!best || offMiles < best.miles) best = { miles: offMiles, bearing: bearingDeg(a, b) };
  }
  return best;
}
