import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { getTrailerWhere, getTruckWhere } from "@/server/tl/whereabouts";

/**
 * Where trucks and trailers are, on the demo database in a workspace of its own: a standing unit next to a stop of one of the fleet's own loads is "at" that facility, a moving one is only
 * "passing" it, a stop of another fleet or an old load never names a place, a hooked trailer rides with its tractor, and nothing leaves the machine:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/whereabouts.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "wb-w";
const OTHER = "wb-other";
const NOW = new Date();
const DOCK = { lat: 32.7767, lng: -96.797 }; // Dallas
const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("equipment whereabouts", () => {
  const ids = { standing: "", moving: "", nofix: "", dropped: "", hooked: "", hookedTruck: "", farTrailer: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "WB fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "WB other", plan: "enterprise" } });
    const stop = (name: string, lat: number, lng: number) => ({ create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: name, lat, lng }] });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "WB-1", status: "accepted", quotedRevenue: 900, scheduledDate: hours(24), stops: stop("Acme Foods dock", DOCK.lat, DOCK.lng) } });
    // An old load and another fleet's load beside the same spot: neither may name a place in W.
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "WB-OLD", status: "completed", quotedRevenue: 900, scheduledDate: hours(24 * 200), stops: stop("Ancient Warehouse", 33.5, -97.5) } });
    await prisma.load.create({ data: { workspaceId: OTHER, loadNumber: "WB-X", status: "accepted", quotedRevenue: 900, scheduledDate: hours(24), stops: stop("Foreign Dock", 33.51, -97.5) } });
    const truck = (name: string, lat: number | null, lng: number | null, engine: string, speed: number) =>
      prisma.vehicle.create({ data: { workspaceId: W, name, ...(lat != null ? { lastLat: lat, lastLng: lng, lastLocatedAt: hours(0.1) } : {}), engineState: engine, lastSpeedMph: speed, lastHeadingDeg: 90 } });
    ids.standing = (await truck("WB Standing", DOCK.lat + 0.001, DOCK.lng, "off", 0)).id;
    ids.moving = (await truck("WB Moving", DOCK.lat + 0.001, DOCK.lng, "moving", 62)).id;
    ids.nofix = (await truck("WB NoFix", null, null, "off", 0)).id;
    ids.hookedTruck = (await truck("WB Hooker", 33.5, -97.5, "moving", 55)).id;
    ids.dropped = (await prisma.trailer.create({ data: { workspaceId: W, number: "WB-DROP", type: "dry_van", lengthFt: 53, lastLat: DOCK.lat, lastLng: DOCK.lng, lastLocatedAt: hours(2), unhookedAt: hours(30), location: "Yard B, door 4" } })).id;
    ids.hooked = (await prisma.trailer.create({ data: { workspaceId: W, number: "WB-HOOK", type: "dry_van", lengthFt: 53, currentVehicleId: ids.hookedTruck, lastLat: 10, lastLng: 10, lastLocatedAt: hours(50) } })).id;
    ids.farTrailer = (await prisma.trailer.create({ data: { workspaceId: W, number: "WB-FAR", lastLat: 45.0, lastLng: -110.0, lastLocatedAt: hours(1), unhookedAt: hours(1) } })).id;
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("a standing truck beside a stop of the fleet's own loads is AT that facility; a moving one is only passing it", async () => {
    const got = await getTruckWhere([ids.standing, ids.moving], W, null, NOW);
    expect(got.get(ids.standing)!.where).toMatchObject({ tier: "at", facility: "Acme Foods dock" });
    expect(got.get(ids.standing)!.where!.label).toMatch(/^At Acme Foods dock/);
    expect(got.get(ids.moving)!.where).toMatchObject({ tier: "near_stop", facility: "Acme Foods dock", standing: false });
    expect(got.get(ids.moving)!.speed).toBe("62 MPH");
    expect(got.get(ids.moving)!.state).toBe("Moving, no load");
  });

  test("a truck with no position is still answered, and says so", async () => {
    const got = await getTruckWhere([ids.nofix], W, null, NOW);
    expect(got.get(ids.nofix)).toMatchObject({ where: null, lat: null, lng: null });
  });

  test("another fleet's stop and an old load never name a place", async () => {
    // The hooking truck sits beside both of them (33.5, -97.5).
    const got = await getTruckWhere([ids.hookedTruck], W, null, NOW);
    const w = got.get(ids.hookedTruck)!.where!;
    expect(w.facility).toBeNull();
    expect(w.nearestStop).toBeNull();
    expect(w.label).not.toMatch(/Foreign|Ancient/);
  });

  test("a hooked trailer is where its tractor is; a dropped one is where it was left, with its dwell and the note typed for it", async () => {
    const got = await getTrailerWhere([ids.hooked, ids.dropped, ids.farTrailer], W, NOW);
    const hooked = got.get(ids.hooked)!;
    expect(hooked.lat).toBeCloseTo(33.5, 3); // not the stale (10, 10) the trailer itself holds
    expect(hooked).toMatchObject({ state: "Hooked", hitched: { kind: "tractor", name: "WB Hooker" }, dwell: null });
    const dropped = got.get(ids.dropped)!;
    expect(dropped.where).toMatchObject({ tier: "at", facility: "Acme Foods dock", standing: true });
    expect(dropped).toMatchObject({ state: "Dropped", typedPlace: "Yard B, door 4", sub: "53V" });
    expect(dropped.dwell).toMatch(/^SITTING /);
    // Far from every stop it still answers (a town the gazetteer knows, or just the point).
    expect(got.get(ids.farTrailer)!.where).toBeTruthy();
  });

  test("nothing it reads belongs to another fleet", async () => {
    expect((await getTruckWhere([ids.standing], OTHER, null, NOW)).size).toBe(0);
    expect((await getTrailerWhere([ids.dropped], OTHER, NOW)).size).toBe(0);
  });
});
