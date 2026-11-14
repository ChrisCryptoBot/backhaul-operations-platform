import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A load's road route (src/server/geo/road-route.ts + src/server/tl/road-route-cache.ts): fetched at most once, from a single load's own view, kept in server memory only (bounded, never in the
 * database), keyed by the stops so changed stops mean no route until one is fetched; miles left snap onto it only within 2 miles, else the straight lane. Mapbox is mocked: nothing leaves.
 */
const drive = vi.fn();
let configured = true;
vi.mock("@/server/geo/mapbox", () => ({ drive: (...a: unknown[]) => drive(...a), mapboxConfigured: () => configured }));

import { alongPolyline } from "@/lib/geo-line";
import { parseRoute } from "@/lib/geo";
import { OFF_ROUTE_MILES, ROAD_ROUTE_NOTE, laneSchedule, routeMilesLeft } from "@/lib/telematics";
import { ensureRoadRoute } from "@/server/geo/road-route";
import { FAIL_TTL_MS, MAX_ROUTES, ROUTE_TTL_MS, forgetRoadRoutes, keepRoadRoute, readRoadRoute, roadRoutesKept, routeKey } from "@/server/tl/road-route-cache";

const A = { lat: 32.0, lng: -97.0 };
const B = { lat: 33.0, lng: -97.0 };
// A road that bends east: (32,-97) -> (32.5,-96.5) -> (33,-97). About 69.1 straight-line miles; a little longer by road.
const ROAD = { coords: [[-97.0, 32.0], [-96.5, 32.5], [-97.0, 33.0]] as Array<[number, number]>, miles: 90 };

beforeEach(() => {
  forgetRoadRoutes();
  drive.mockReset();
  configured = true;
});
afterEach(() => vi.useRealTimers());

describe("the directions answer keeps its road line", () => {
  it("parseRoute keeps a well-formed GeoJSON LineString, and nothing else", () => {
    const base = { distance: 1609.344, duration: 60, legs: [{ distance: 1609.344 }] };
    expect(parseRoute({ routes: [{ ...base, geometry: { type: "LineString", coordinates: [[-97, 32], [-96.9, 32.1]] } }] })?.coords).toEqual([[-97, 32], [-96.9, 32.1]]);
    expect(parseRoute({ routes: [base] })).toEqual({ meters: 1609.344, seconds: 60, legsMeters: [1609.344] });
    expect(parseRoute({ routes: [{ ...base, geometry: { type: "LineString", coordinates: [[-97, 32]] } }] })?.coords).toBeUndefined();
    expect(parseRoute({ routes: [{ ...base, geometry: { type: "LineString", coordinates: [[-97, 132], [0, 0]] } }] })?.coords).toBeUndefined();
    expect(parseRoute({ routes: [{ ...base, geometry: "encoded-polyline" }] })?.coords).toBeUndefined();
  });

  it("drive() asks for a simplified GeoJSON line only when asked, through the same ledger claim", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/server/geo/mapbox.ts"), "utf8");
    expect(src).toContain('{ access_token: token(), overview: "simplified", geometries: "geojson" }');
    expect(src).toContain('{ access_token: token(), overview: "false" }');
    expect(src).toMatch(/directions\/v5\/mapbox\/driving\/\$\{coords\}\?\$\{q\.toString\(\)\}`, "mapbox_directions"\)/);
  });
});

describe("the road-route memory", () => {
  it("keys by the load and its stop points, so changed stops have no route", () => {
    keepRoadRoute("L1", [A, B], ROAD);
    expect(readRoadRoute("L1", [A, B])).toEqual(ROAD);
    expect(readRoadRoute("L1", [A, { lat: 33.1, lng: -97 }])).toBeUndefined();
    expect(readRoadRoute("L2", [A, B])).toBeUndefined();
    expect(routeKey("L1", [A, B])).toBe("L1|32.000000,-97.000000;33.000000,-97.000000");
  });

  it("a route is kept 12 hours and a failure 10 minutes", () => {
    const t = 1_000_000;
    keepRoadRoute("L1", [A, B], ROAD, t);
    keepRoadRoute("L2", [A, B], null, t);
    expect(readRoadRoute("L1", [A, B], t + ROUTE_TTL_MS - 1)).toEqual(ROAD);
    expect(readRoadRoute("L2", [A, B], t + FAIL_TTL_MS - 1)).toBeNull();
    expect(readRoadRoute("L2", [A, B], t + FAIL_TTL_MS)).toBeUndefined();
    expect(readRoadRoute("L1", [A, B], t + ROUTE_TTL_MS)).toBeUndefined();
    expect(ROUTE_TTL_MS).toBe(12 * 3_600_000);
    expect(FAIL_TTL_MS).toBe(10 * 60_000);
  });

  it("holds at most 300 routes, dropping the oldest first", () => {
    for (let i = 0; i < MAX_ROUTES + 5; i++) keepRoadRoute(`L${i}`, [A, B], ROAD);
    expect(roadRoutesKept()).toBe(MAX_ROUTES);
    expect(readRoadRoute("L0", [A, B])).toBeUndefined();
    expect(readRoadRoute(`L${MAX_ROUTES + 4}`, [A, B])).toEqual(ROAD);
  });
});

describe("fetching a load's road route: at most once, and fail soft", () => {
  it("asks once for the line (geometry), shares a fetch made at the same moment, then answers from memory", async () => {
    drive.mockResolvedValue({ meters: 144_841, seconds: 5_400, legsMeters: [144_841], coords: ROAD.coords });
    const [a, b] = await Promise.all([ensureRoadRoute("L1", [A, B]), ensureRoadRoute("L1", [A, B])]);
    const c = await ensureRoadRoute("L1", [A, B]);
    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive.mock.calls[0]![1]).toEqual({ geometry: true });
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(a!.miles).toBeCloseTo(90, 0);
  });

  it("no key: no call and nothing remembered; refused or no route: null, remembered ten minutes", async () => {
    configured = false;
    expect(await ensureRoadRoute("L1", [A, B])).toBeNull();
    expect(drive).not.toHaveBeenCalled();
    expect(readRoadRoute("L1", [A, B])).toBeUndefined();
    configured = true;
    drive.mockResolvedValue(null); // the ledger refused, the provider had no route, or the request failed: drive() fails soft to null
    expect(await ensureRoadRoute("L1", [A, B])).toBeNull();
    expect(await ensureRoadRoute("L1", [A, B])).toBeNull();
    expect(drive).toHaveBeenCalledTimes(1);
    drive.mockRejectedValue(new Error("boom"));
    expect(await ensureRoadRoute("L9", [A, B])).toBeNull();
  });

  it("fewer than two or more than 25 stops: no call", async () => {
    expect(await ensureRoadRoute("L1", [A])).toBeNull();
    expect(await ensureRoadRoute("L1", Array.from({ length: 26 }, (_, i) => ({ lat: 30 + i * 0.1, lng: -97 })))).toBeNull();
    expect(drive).not.toHaveBeenCalled();
  });
});

describe("miles left on the road, with the off-route guard", () => {
  it("alongPolyline measures how far along a line a point is, and how far off it", () => {
    const at = alongPolyline({ lat: 32.5, lng: -96.5 }, ROAD.coords)!;
    expect(at.offMiles).toBeLessThan(0.01);
    expect(at.alongMiles / at.totalMiles).toBeCloseTo(0.5, 2);
  });

  it("on the road: the share of the road still ahead times the route's driven miles", () => {
    const halfway = routeMilesLeft({ origin: A, destination: B, here: { lat: 32.5, lng: -96.5 }, loadedMiles: 200, road: ROAD });
    expect(halfway.basis).toBe("road");
    expect(halfway.offRoute).toBe(false);
    expect(halfway.miles).toBeCloseTo(45, 0); // half of the route's 90, not half of the load's 200
  });

  it(`more than ${OFF_ROUTE_MILES} miles off the road: not snapped; the straight lane with the load's own miles`, () => {
    // At the lane's midpoint (32.5, -97) the bent road is about 29 miles east.
    const off = routeMilesLeft({ origin: A, destination: B, here: { lat: 32.5, lng: -97.0 }, loadedMiles: 200, road: ROAD });
    expect(off).toMatchObject({ basis: "lane", offRoute: true });
    expect(off.miles).toBeCloseTo(100, 0);
    const none = routeMilesLeft({ origin: A, destination: B, here: { lat: 32.5, lng: -97.0 }, loadedMiles: 200, road: null });
    expect(none).toMatchObject({ basis: "lane", offRoute: false });
    expect(OFF_ROUTE_MILES).toBe(2);
  });

  it("the schedule check uses the road when it has one", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    const here = { lat: 32.5, lng: -96.5 };
    // 45 road miles at 60 mph is 45 minutes; the window closes in 50 (plus 15 grace): on schedule. On the lane with 200 loaded miles it would be 100 miles: late.
    const windowLatest = now + 50 * 60_000;
    expect(laneSchedule({ origin: A, destination: B, here, loadedMiles: 200, speedMph: 60, windowLatest, now, road: ROAD })).toBe("on_schedule");
    expect(laneSchedule({ origin: A, destination: B, here, loadedMiles: 200, speedMph: 60, windowLatest, now })).toBe("late");
  });

  it("says plainly what the road line is", () => {
    expect(ROAD_ROUTE_NOTE).toContain("mapbox/driving");
    expect(ROAD_ROUTE_NOTE).toMatch(/not truck routing/);
  });
});

describe("no screen that reads many loads can fetch a route, and no route is stored", () => {
  const SRC = path.join(__dirname, "../src");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const files = walk(SRC);
  it("only the single-load tracking imports the fetcher, and only a load page and a clicked unit call that tracking", () => {
    const importers = files.filter((f) => /from "@\/server\/geo\/road-route"/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(importers).toEqual(["server/tl/load-tracking.ts"]);
    const callers = files.filter((f) => /getLoadTracking\(/.test(fs.readFileSync(f, "utf8")) && !f.endsWith(`load-tracking.ts`)).map(rel).sort();
    expect(callers).toEqual(["components/desk/load-view.tsx", "server/tl/radar-route.ts"]);
  });
  it("the map's bulk reads, the Late chip and the hover only read the memory", () => {
    for (const f of ["server/tl/radar.ts", "server/tl/whereabouts.ts", "server/tl/radar-query.ts", "app/(desk)/fleet/map/data/route.ts"]) {
      const s = fs.readFileSync(path.join(SRC, f), "utf8");
      expect(s, f).not.toMatch(/ensureRoadRoute|server\/geo\/road-route|drive\(/);
    }
  });
  it("the route is never written to the database", () => {
    for (const f of ["server/geo/road-route.ts", "server/tl/road-route-cache.ts"]) expect(fs.readFileSync(path.join(SRC, f), "utf8"), f).not.toMatch(/prisma|\$executeRaw|\.create\(|\.update\(/);
  });
});
