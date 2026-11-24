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

export type Along = { offMiles: number; alongMiles: number };
/** A road line ([lng, lat] pairs) ready to be measured against many points: its whole length, and for a point how far off it is and how far along its nearest part is. Null under two points. */
export type LineIndex = { totalMiles: number; at: (p: LatLng) => Along; slice: (fromMiles: number, toMiles: number) => Array<[number, number]> };
export function indexLine(coords: ReadonlyArray<readonly [number, number]>): LineIndex | null {
  const n = coords.length - 1;
  if (n < 1) return null;
  // Flat miles per segment, around its own latitude (the same as projectOnLine), worked out once: a road line has thousands of them.
  const kx = new Float64Array(n);
  const starts = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    kx[i] = Math.cos(rad((a[1] + b[1]) / 2)) * MILES_PER_DEG_LAT;
    starts[i + 1] = starts[i]! + Math.hypot((b[0] - a[0]) * kx[i]!, (b[1] - a[1]) * MILES_PER_DEG_LAT);
  }
  const at = (p: LatLng): Along => {
    let best = Infinity;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      const dx = (b[0] - a[0]) * kx[i]!;
      const dy = (b[1] - a[1]) * MILES_PER_DEG_LAT;
      const px = (p.lng - a[0]) * kx[i]!;
      const py = (p.lat - a[1]) * MILES_PER_DEG_LAT;
      const len2 = dx * dx + dy * dy;
      const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const d2 = (px - dx * f) ** 2 + (py - dy * f) ** 2;
      if (d2 < best) {
        best = d2;
        along = starts[i]! + (starts[i + 1]! - starts[i]!) * f;
      }
    }
    return { offMiles: Math.sqrt(best), alongMiles: along };
  };
  const pointAt = (miles: number, from: number): { p: [number, number]; i: number } => {
    let i = from;
    while (i < n - 1 && starts[i + 1]! < miles) i++;
    const seg = starts[i + 1]! - starts[i]!;
    const f = seg === 0 ? 0 : Math.min(1, Math.max(0, (miles - starts[i]!) / seg));
    const a = coords[i]!;
    const b = coords[i + 1]!;
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], i };
  };
  const slice = (fromMiles: number, toMiles: number): Array<[number, number]> => {
    const a = pointAt(fromMiles, 0);
    const b = pointAt(toMiles, a.i);
    const out: Array<[number, number]> = [a.p];
    for (let i = a.i + 1; i <= b.i; i++) out.push([coords[i]![0], coords[i]![1]]);
    out.push(b.p);
    return out;
  };
  return { totalMiles: starts[n]!, at, slice };
}

/** One point against a line: how far off, how far along, and the line's whole length, in miles. */
export function alongPolyline(p: LatLng, coords: ReadonlyArray<readonly [number, number]>): (Along & { totalMiles: number }) | null {
  const line = indexLine(coords);
  return line ? { ...line.at(p), totalMiles: line.totalMiles } : null;
}

/**
 * The same road with the points that change nothing left out: every point dropped is within `meters` of the line that is kept (Douglas and Peucker), so a bend is never cut. At the default, four
 * meters, the line stays inside its own lanes at the closest zoom the map has.
 */
export function thinLine(coords: ReadonlyArray<readonly [number, number]>, meters = 4): Array<[number, number]> {
  const n = coords.length;
  if (n <= 2) return coords.map((c) => [c[0], c[1]]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const limit = meters / 1609.344;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    const a = coords[i0]!;
    const b = coords[i1]!;
    const k = Math.cos(rad((a[1] + b[1]) / 2)) * MILES_PER_DEG_LAT;
    const dx = (b[0] - a[0]) * k;
    const dy = (b[1] - a[1]) * MILES_PER_DEG_LAT;
    const len2 = dx * dx + dy * dy;
    let worst = limit * limit;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const px = (coords[i]![0] - a[0]) * k;
      const py = (coords[i]![1] - a[1]) * MILES_PER_DEG_LAT;
      const f = len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const d2 = (px - dx * f) ** 2 + (py - dy * f) ** 2;
      if (d2 > worst) {
        worst = d2;
        at = i;
      }
    }
    if (at >= 0) {
      keep[at] = 1;
      stack.push([i0, at], [at, i1]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1).map((c) => [c[0], c[1]]);
}

/** A fix this near the road line was on that road. */
export const ON_ROAD_MILES = 0.25;
/** Two fixes farther apart than this along the road are not joined: nothing was read between them. */
export const MAX_TRAIL_GAP_MILES = 10;

/**
 * Where a truck has been, along the road: the stretch of the load's road line between each two consecutive fixes that were both on it, driven forward, and no farther apart than the gap. Everything
 * else is left as the fixes themselves (the caller draws a dot for each): two fixes are never joined with a straight line, because that is not where the truck drove.
 */
export function trailOnRoad(points: ReadonlyArray<LatLng>, road: ReadonlyArray<readonly [number, number]> | null | undefined): Array<Array<[number, number]>> {
  const line = road ? indexLine(road) : null;
  if (!line || points.length < 2) return [];
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> | null = null;
  let prev: Along | null = null;
  for (const p of points) {
    const here = line.at(p);
    const on = here.offMiles <= ON_ROAD_MILES ? here : null;
    const gap = on && prev ? on.alongMiles - prev.alongMiles : 0;
    if (on && prev && gap > 0 && gap <= MAX_TRAIL_GAP_MILES) {
      const part = line.slice(prev.alongMiles, on.alongMiles);
      if (cur) cur.push(...part.slice(1));
      else runs.push((cur = part));
    } else cur = null;
    prev = on;
  }
  return runs;
}
