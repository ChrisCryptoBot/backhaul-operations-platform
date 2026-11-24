import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The radar's background fetch of road routes (server/tl/warm-routes.ts) on a real database, in a workspace of its own. The directions provider is mocked: nothing leaves the machine.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/warm-routes.integration.test.ts
 */
const drive = vi.fn();
let configured = true;
vi.mock("@/server/geo/mapbox", () => ({ drive: (...a: unknown[]) => drive(...a), mapboxConfigured: () => configured, takeRefusal: () => null }));

import { prisma } from "@/lib/db";
import { getRadarData } from "@/server/tl/radar";
import { MAX_ROUTES, forgetRoadRoutes, keepRoadRoute } from "@/server/tl/road-route-cache";
import { PASS_EVERY_MS, PASS_MAX, forgetWarming, warmRoadRoutes } from "@/server/tl/warm-routes";

const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "warm-w";
const NOW = Date.now();
const H = 3_600_000;
const FROM = { lat: 32.0, lng: -97.0 };
const TO = { lat: 33.0, lng: -97.0 };
const road = (points: Array<{ lat: number; lng: number }>) => ({ meters: 160_934, seconds: 6_000, legsMeters: [160_934], coords: points.map((p) => [p.lng, p.lat]) });

describe.skipIf(!run)("the radar's background fetch of road routes", () => {
  const load = async (n: string, o: { status?: string; at?: { lat: number; lng: number }; seen?: number; dueIn?: number; terminal?: string; workspaceId?: string } = {}) => {
    const workspaceId = o.workspaceId ?? W;
    const v = await prisma.vehicle.create({ data: { workspaceId, name: `WR ${n}`, terminal: o.terminal ?? null, lastLat: (o.at ?? { lat: 32.4, lng: -97 }).lat, lastLng: (o.at ?? { lat: 32.4, lng: -97 }).lng, lastLocatedAt: new Date(NOW - (o.seen ?? 5) * 60_000), engineState: "moving", lastSpeedMph: 60 } });
    return prisma.load.create({
      data: {
        workspaceId, loadNumber: n, status: o.status ?? "in_progress", vehicleId: v.id,
        stops: { create: [{ stopSequence: 1, stopType: "pickup", addressString: "A", ...FROM }, { stopSequence: 2, stopType: "delivery", addressString: "B", ...TO, timeWindowLatest: new Date(NOW + (o.dueIn ?? 8) * H) }] }
      }
    });
  };
  const clear = async () => {
    await prisma.load.deleteMany({ where: { workspaceId: { in: [W, `${W}2`] } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: { in: [W, `${W}2`] } } });
  };
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [W, `${W}2`] } } });
    for (const id of [W, `${W}2`]) await prisma.workspace.create({ data: { id, name: "Warm fleet", plan: "enterprise" } });
  });
  beforeEach(async () => {
    await clear();
    forgetRoadRoutes();
    forgetWarming();
    configured = true;
    drive.mockReset();
    drive.mockImplementation(async (points) => road(points));
  });
  afterAll(async () => {
    await clear();
    await prisma.workspace.deleteMany({ where: { id: { in: [W, `${W}2`] } } });
  });

  test("a load under way gets its road, as background, and the Late chip then knows it; the read itself asks nothing", async () => {
    await load("WR-1", { dueIn: 0.2 }); // about 60 road miles left in twelve minutes
    expect((await getRadarData(W, null, new Date(NOW))).tractors[0]!.late).toBe(false); // no road yet, the window is open: nothing is said
    expect(drive).not.toHaveBeenCalled();
    expect(await warmRoadRoutes(W, NOW)).toEqual({ asked: 1, got: 1 });
    expect(drive.mock.calls[0]![1]).toMatchObject({ background: true });
    expect((await getRadarData(W, null, new Date(NOW))).tractors[0]!.late).toBe(true);
    // Once had, it is not asked for again.
    expect(await warmRoadRoutes(W, NOW + PASS_EVERY_MS)).toEqual({ asked: 0, got: 0 });
    expect(drive).toHaveBeenCalledTimes(1);
  });

  test("only loads under way with a fresh position, not yet there, in this company, whichever terminal", async () => {
    await load("WR-OLD", { seen: 91 });
    await load("WR-ACC", { status: "accepted" });
    await load("WR-DONE", { status: "completed" });
    await load("WR-THERE", { at: { lat: 33.001, lng: -97 } });
    await load("WR-OTHER", { workspaceId: `${W}2` });
    await load("WR-SOUTH", { terminal: "South" });
    expect(await warmRoadRoutes(W, NOW)).toEqual({ asked: 1, got: 1 });
  });

  test("a truck off its road is put on a new one from where it is", async () => {
    const l = await load("WR-OFF", { at: { lat: 32.5, lng: -97.6 } });
    keepRoadRoute(l.id, [FROM, TO], { coords: [[-97, 32], [-97, 33]], miles: 70 });
    expect(await warmRoadRoutes(W, NOW)).toEqual({ asked: 1, got: 1 });
    expect(drive.mock.calls[0]![0].map((p: { lat: number; lng: number }) => [p.lat, p.lng])).toEqual([[32.5, -97.6], [33, -97]]);
  });

  test("a few a pass, soonest due first, and a pass a minute however many screens are open", async () => {
    for (let i = 0; i < PASS_MAX + 2; i++) await load(`WR-${i}`, { dueIn: 20 - i });
    const [a, b] = await Promise.all([warmRoadRoutes(W, NOW), warmRoadRoutes(W, NOW)]);
    expect(a.asked + b.asked).toBe(PASS_MAX);
    expect(await warmRoadRoutes(W, NOW + PASS_EVERY_MS - 1)).toEqual({ asked: 0, got: 0 });
    expect(await warmRoadRoutes(W, NOW + PASS_EVERY_MS)).toEqual({ asked: 2, got: 2 });
  });

  test("a failure waits ten minutes; no key, or a memory nearly full, asks nothing", async () => {
    await load("WR-F");
    drive.mockResolvedValue(null);
    expect(await warmRoadRoutes(W, NOW)).toEqual({ asked: 1, got: 0 });
    expect(await warmRoadRoutes(W, NOW + 5 * 60_000)).toEqual({ asked: 0, got: 0 });
    configured = false;
    expect(await warmRoadRoutes(W, NOW + 11 * 60_000)).toEqual({ asked: 0, got: 0 });
    configured = true;
    forgetWarming();
    for (let i = 0; i < MAX_ROUTES * 0.8; i++) keepRoadRoute(`FULL${i}`, [FROM, TO], { coords: [[-97, 32], [-97, 33]], miles: 70 });
    expect(await warmRoadRoutes(W, NOW + 12 * 60_000)).toEqual({ asked: 0, got: 0 });
  });
});
