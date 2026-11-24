import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A load's road route (src/server/geo/road-route.ts + src/server/tl/road-route-cache.ts): fetched at most once, from a single load's own view, kept in server memory only (bounded, never in the
 * database), keyed by the stops so changed stops mean no route until one is fetched; miles left and an arrival come from a road within 2 miles of the truck, or there are none: a straight line is never put in their place. Mapbox is mocked: nothing leaves.
 */
const drive = vi.fn();
let configured = true;
vi.mock("@/server/geo/mapbox", () => ({ drive: (...a: unknown[]) => drive(...a), mapboxConfigured: () => configured }));

import { MAX_TRAIL_GAP_MILES, alongPolyline, thinLine, trailOnRoad } from "@/lib/geo-line";
import { parseRoute, roadName } from "@/lib/geo";
import { OFF_ROUTE_MILES, ROAD_ROUTE_NOTE, milesAlong, roadMilesLeft, roadSchedule, stopsAhead } from "@/lib/telematics";
import { BACKGROUND_DIRECTIONS, SPEND } from "@/lib/spend";
import { BACKGROUND_WAY_MS, ensureRoadRoute, ensureWayThere } from "@/server/geo/road-route";
import { FAIL_TTL_MS, MAX_POINTS, MAX_ROUTES, ROUTE_TTL_MS, forgetRoadRoutes, keepRoadRoute, keepWayThere, readRoadRoute, readWayThere, roadRoutesKept, routeKey } from "@/server/tl/road-route-cache";

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

  it("names the roads it runs on, joining steps on the same one", () => {
    expect([roadName("I 65 South", ""), roadName("I 90; I 94 East", "Dan Ryan Expressway"), roadName("US 52", ""), roadName(undefined, "West 11th Street"), roadName(undefined, "")]).toEqual(["I-65", "I-90", "US-52", "West 11th Street", ""]);
    const steps = [{ distance: 100, name: "Main Street" }, { distance: 300, ref: "I 65" }, { distance: 600, ref: "I 65 South" }];
    expect(parseRoute({ routes: [{ distance: 1000, duration: 60, legs: [{ distance: 1000, steps }], geometry: { type: "LineString", coordinates: [[-97, 32], [-96.9, 32.1]] } }] })?.roads).toEqual([{ name: "Main Street", meters: 100 }, { name: "I-65", meters: 900 }]);
  });

  it("drive() asks for the whole GeoJSON line (never the simplified one) only when asked, through the same ledger claim", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/server/geo/mapbox.ts"), "utf8");
    expect(src).toContain('{ access_token: token(), overview: "full", geometries: "geojson", steps: "true" }');
    expect(src).not.toContain('overview: "simplified"');
    expect(src).toContain('{ access_token: token(), overview: "false" }');
    expect(src).toMatch(/directions\/v5\/mapbox\/driving\/\$\{coords\}\?\$\{q\.toString\(\)\}`, "mapbox_directions", opts\.background\)/);
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

describe("the memory is bounded by the size of the roads too", () => {
  it("drops the oldest when the points together pass the limit", () => {
    const big = (n: number) => ({ coords: Array.from({ length: n }, (_, i) => [-97 + i / n, 32] as [number, number]), miles: 50 });
    keepRoadRoute("OLD", [A, B], big(MAX_POINTS * 0.6));
    keepRoadRoute("NEW", [A, B], big(MAX_POINTS * 0.6));
    expect(readRoadRoute("OLD", [A, B])).toBeUndefined();
    expect(readRoadRoute("NEW", [A, B])).not.toBeUndefined();
  });
});

describe("the way there: a truck off its route is put on a road from where it is, never on a straight line", () => {
  const OFF = { lat: 32.5, lng: -97.4 };
  const WAY = { meters: 80_000, seconds: 3_600, legsMeters: [80_000], coords: [[-97.4, 32.5], [-97.2, 32.8], [-97.0, 33.0]] as Array<[number, number]> };
  it("asks for the road from the truck through the stops still ahead", async () => {
    drive.mockResolvedValue(WAY);
    const r = await ensureWayThere("L1", OFF, [B]);
    expect(drive.mock.calls[0]![0].map((p: { lat: number; lng: number }) => [p.lat, p.lng])).toEqual([[32.5, -97.4], [33, -97]]);
    expect(milesAlong(OFF, r!)!.miles).toBeCloseTo(80_000 / 1609.344, 1);
  });
  it("is asked for once while the truck follows it, and at most every ten minutes when it does not", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    drive.mockResolvedValue(WAY);
    await ensureWayThere("L1", OFF, [B]);
    await ensureWayThere("L1", { lat: 31, lng: -99 }, [B]); // gone elsewhere, seconds later
    expect(drive).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + FAIL_TTL_MS + 1);
    await ensureWayThere("L1", { lat: 32.8, lng: -97.2 }, [B]); // still on it
    expect(drive).toHaveBeenCalledTimes(1);
    await ensureWayThere("L1", { lat: 31, lng: -99 }, [B]); // off it
    expect(drive).toHaveBeenCalledTimes(2);
  });
  it("a failure is remembered, no key asks nothing, and a load keeps at most one", async () => {
    drive.mockResolvedValue(null);
    expect(await ensureWayThere("L1", OFF, [B])).toBeNull();
    expect(await ensureWayThere("L1", OFF, [B])).toBeNull();
    expect(drive).toHaveBeenCalledTimes(1);
    configured = false;
    expect(await ensureWayThere("L2", OFF, [B])).toBeNull();
    expect(readWayThere("L2", [B])).toBeUndefined();
    keepWayThere("L1", [B], ROAD);
    keepWayThere("L1", [B], ROAD);
    expect(roadRoutesKept()).toBe(1);
  });
});

describe("a background fetch is held to its own share and never spoils a person's", () => {
  it("asks as background; a null is not remembered, so a person who opens the load still gets an answer", async () => {
    drive.mockResolvedValue(null);
    expect(await ensureRoadRoute("L1", [A, B], { background: true })).toBeNull();
    expect(drive.mock.calls[0]![1]).toEqual({ geometry: true, background: true });
    expect(readRoadRoute("L1", [A, B])).toBeUndefined();
    expect(await ensureWayThere("L1", A, [B], { background: true })).toBeNull();
    expect(readWayThere("L1", [B])).toBeUndefined();
    drive.mockResolvedValue({ meters: 144_841, seconds: 5_400, legsMeters: [144_841], coords: ROAD.coords });
    expect((await ensureRoadRoute("L1", [A, B]))!.miles).toBeCloseTo(90, 0);
    expect(drive.mock.calls[2]![1]).toEqual({ geometry: true });
  });
  it("its allowance is about half of the desk's, and a refusal is never shown as a person's", () => {
    const full = SPEND.mapbox_directions.limits;
    expect(BACKGROUND_DIRECTIONS.workspaceDay!).toBeLessThanOrEqual(full.workspaceDay! / 2);
    expect(BACKGROUND_DIRECTIONS.globalDay!).toBeLessThanOrEqual(full.globalDay! / 2);
    expect(BACKGROUND_DIRECTIONS.globalMonth!).toBeLessThan(full.globalMonth!);
    const src = fs.readFileSync(path.join(__dirname, "../src/server/geo/mapbox.ts"), "utf8");
    expect(src).toContain("if (!background) lastRefusal =");
    expect(src).toContain("background ? { limits: BACKGROUND_DIRECTIONS } : {}");
  });
  it("a truck that keeps leaving its road is put on a new one at most every half hour in the background", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    drive.mockResolvedValue({ meters: 80_000, seconds: 3_600, legsMeters: [80_000], coords: [[-97.4, 32.5], [-97.0, 33.0]] });
    await ensureWayThere("L1", { lat: 32.5, lng: -97.4 }, [B], { background: true });
    vi.setSystemTime(1_000_000 + BACKGROUND_WAY_MS - 1);
    await ensureWayThere("L1", { lat: 31, lng: -99 }, [B], { background: true });
    expect(drive).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + BACKGROUND_WAY_MS + 1);
    await ensureWayThere("L1", { lat: 31, lng: -99 }, [B], { background: true });
    expect(drive).toHaveBeenCalledTimes(2);
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
    const halfway = roadMilesLeft({ here: { lat: 32.5, lng: -96.5 }, approaching: false, planned: ROAD, way: null });
    expect(halfway!.miles).toBeCloseTo(45, 0);
  });

  it(`more than ${OFF_ROUTE_MILES} miles off the road, or with no road: nothing, not a straight line`, () => {
    // At the lane's midpoint (32.5, -97) the bent road is about 29 miles east.
    expect(roadMilesLeft({ here: { lat: 32.5, lng: -97.0 }, approaching: false, planned: ROAD, way: null })).toBeNull();
    expect(roadMilesLeft({ here: { lat: 32.5, lng: -97.0 }, approaching: false, planned: null, way: undefined })).toBeNull();
    const way = { coords: [[-97.0, 32.5], [-97.0, 33.0]] as Array<[number, number]>, miles: 40 };
    expect(roadMilesLeft({ here: { lat: 32.5, lng: -97.0 }, approaching: false, planned: ROAD, way })!.miles).toBeCloseTo(40, 1);
    expect(OFF_ROUTE_MILES).toBe(2);
  });

  it("a truck on its way to the first stop is measured on the way there, not from wherever it happens to be along the lane", () => {
    const here = { lat: 32.5, lng: -96.5 }; // on the planned road, halfway, with the pickup still to do
    expect(roadMilesLeft({ here, approaching: true, planned: ROAD, way: null })).toBeNull();
    const way = { coords: [[-96.5, 32.5], [-97.0, 32.0], [-96.5, 32.5], [-97.0, 33.0]] as Array<[number, number]>, miles: 135 };
    expect(roadMilesLeft({ here, approaching: true, planned: ROAD, way })!.miles).toBeGreaterThan(130);
  });

  it("the stops ahead are the ones after the last arrival; a load under way has left its first; the last is always ahead", () => {
    const s = (p: { lat: number; lng: number }, arrived: boolean) => ({ ...p, arrivedAt: arrived ? new Date() : null });
    const far = { lat: 40, lng: -90 };
    expect(stopsAhead("accepted", [s(A, false), s(B, false)], far)).toMatchObject({ approaching: true, ahead: [A, B] });
    expect(stopsAhead("accepted", [s(A, false), s(B, false)], A).approaching).toBe(false); // at the pickup: the planned route starts here
    expect(stopsAhead("in_progress", [s(A, false), s(B, false)], far)).toMatchObject({ approaching: false, ahead: [B] });
    expect(stopsAhead("in_progress", [s(A, true), s(B, true)], far).ahead).toHaveLength(1);
  });

  it("names the road only for a fix that is on it", () => {
    const road = { ...ROAD, roads: [{ name: "I-35", until: 0.5 }, { name: "US-67", until: 1 }] };
    expect(milesAlong({ lat: 32.25, lng: -96.75 }, road)!.roadName).toBe("I-35");
    expect(milesAlong({ lat: 32.75, lng: -96.75 }, road)!.roadName).toBe("US-67");
    expect(milesAlong({ lat: 32.25, lng: -96.73 }, road)!.roadName).toBeNull(); // near the route, not on the road
    expect(milesAlong({ lat: 32.25, lng: -96.75 }, ROAD)!.roadName).toBeNull();
  });

  it("the schedule: the road's arrival, else only what the clock says", () => {
    const now = Date.UTC(2026, 10, 13, 12);
    const at = (milesLeft: number | null, mins: number) => roadSchedule({ here: { lat: 32.5, lng: -96.5 }, destination: B, milesLeft, speedMph: 60, windowLatest: now + mins * 60_000, now });
    expect(at(45, 50)).toBe("on_schedule");
    expect(at(100, 50)).toBe("late");
    expect(at(null, 50)).toBeNull(); // no road miles and the window is open: nothing is said
    expect(at(null, -60)).toBe("late"); // the window closed and it is not there
    expect(roadSchedule({ here: B, destination: B, milesLeft: 0, speedMph: 0, windowLatest: now - 3_600_000, now })).toBeNull();
  });

  it("says plainly what the road line is", () => {
    expect(ROAD_ROUTE_NOTE).toContain("mapbox/driving");
    expect(ROAD_ROUTE_NOTE).toMatch(/not truck routing/);
  });

  it("a thinned line never leaves the road by more than its few meters, and keeps every bend", () => {
    const bend = Array.from({ length: 2000 }, (_, i) => [-97 + i / 2000, 32 + Math.sin(i / 60) * 0.05] as [number, number]);
    const thin = thinLine(bend);
    expect(thin.length).toBeLessThan(bend.length);
    for (const [lng, lat] of bend) expect(alongPolyline({ lat, lng }, thin)!.offMiles * 1609.344).toBeLessThan(5);
    expect(thin[0]).toEqual(bend[0]);
    expect(thin[thin.length - 1]).toEqual(bend[bend.length - 1]);
  });

  it(`where a truck has been is drawn along the road, between fixes on it and no more than ${MAX_TRAIL_GAP_MILES} miles apart; two fixes are never joined straight`, () => {
    // A road that goes out and around: (32,-97) -> (32.04,-96.96) -> (32.08,-97).
    const road = [[-97.0, 32.0], [-96.96, 32.04], [-97.0, 32.08]] as Array<[number, number]>;
    const a = { lat: 32.01, lng: -96.99 };
    const b = { lat: 32.07, lng: -96.99 };
    const runs = trailOnRoad([a, b], road);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContainEqual([-96.96, 32.04]); // it goes by the bend, not straight up
    expect(trailOnRoad([a, b], null)).toEqual([]); // no road: the dots only
    expect(trailOnRoad([a, { lat: 32.04, lng: -97.0 }, b], road)).toEqual([]); // a fix off the road joins nothing
    expect(trailOnRoad([b, a], road)).toEqual([]); // backwards joins nothing
    expect(trailOnRoad([{ lat: 32, lng: -97 }, { lat: 33, lng: -97 }], [[-97, 32], [-97, 33]])).toEqual([]); // a long gap
  });
});

describe("no straight lines", () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "../src", p), "utf8");
  it("no screen draws a line from stop to stop or from fix to fix, and no reader measures one", () => {
    for (const p of ["components/desk/radar-map.tsx", "components/desk/load-tracker.tsx", "server/tl/load-tracking.ts", "server/tl/radar.ts", "server/tl/whereabouts.ts", "server/tl/radar-route.ts", "lib/telematics.ts"]) expect(src(p), p).not.toMatch(/route-lane|laneProgress|milesToGo|laneSchedule|laneNote|trailRuns|nearestCorridor|INTERSTATES|straightMiles|stops\.map\(at\)/);
    expect(fs.existsSync(path.join(__dirname, "../src/lib/basemap/interstates.ts"))).toBe(false);
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
  it("only the single-load tracking and the radar's background fetch import the fetcher, and only a load page and a clicked unit call that tracking", () => {
    const importers = files.filter((f) => /from "@\/server\/geo\/road-route"/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(importers.sort()).toEqual(["server/tl/load-tracking.ts", "server/tl/warm-routes.ts"]);
    // The background fetch is asked for by the radar's own data route, and by nothing else.
    expect(files.filter((f) => /warmRoadRoutes\(/.test(fs.readFileSync(f, "utf8"))).map(rel).sort()).toEqual(["app/(desk)/fleet/map/data/route.ts", "server/tl/warm-routes.ts"]);
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
