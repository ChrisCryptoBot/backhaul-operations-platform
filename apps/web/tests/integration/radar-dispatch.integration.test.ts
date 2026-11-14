import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { readRadarParams } from "@/lib/radar-points";
import { getRadarData } from "@/server/tl/radar";
import { radarOpenLoads } from "@/server/tl/radar-open-loads";
import { radarPoints } from "@/server/tl/radar-query";
import { unitRoute } from "@/server/tl/radar-route";
import { inTerminal } from "@/server/tl/terminal-sql";

/**
 * The radar's dispatch tools on a real database, in a workspace of its own: a truck is in a terminal's view by its own terminal or its seated driver's; a running truck's route (lane, trail, live
 * lines) for the truck and for the trailer it pulls; the exception chips and their counts; and open freight that follows the header's needs-a-driver rule and scope. Nothing leaves the machine.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/radar-dispatch.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "rdx-w";
const NOW = new Date();
const H = 3_600_000;
const q = (o: Record<string, string>) => readRadarParams((k) => o[k]);

async function wipe(id: string) {
  await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id } } }, { driver: { workspace: { id } } }] } });
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("radar dispatch tools", () => {
  const ids = { north: "", seated: "", south: "", benched: "", idle: "", load: "", hooked: "", longDrop: "", shortDrop: "" };
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "RDX fleet", plan: "enterprise" } });
    const truck = (name: string, terminal: string | null, lat: number, lng: number, engine = "moving", speed = 60) =>
      prisma.vehicle.create({ data: { workspaceId: W, name, terminal, lastLat: lat, lastLng: lng, lastLocatedAt: NOW, engineState: engine, lastSpeedMph: speed, lastHeadingDeg: 160 } });
    ids.north = (await truck("RDX North", "North", 31.5, -96.4)).id;
    ids.seated = (await truck("RDX Seated", null, 32.9, -97.0, "off", 0)).id;
    ids.south = (await truck("RDX South-seated", null, 29.8, -95.4, "off", 0)).id;
    ids.benched = (await truck("RDX Benched", null, 30.3, -97.7, "off", 0)).id;
    ids.idle = (await truck("RDX Idle", "North", 32.7, -97.3, "idle", 0)).id;
    await prisma.driver.create({ data: { workspaceId: W, name: "Nora North", terminal: "North", active: true, assignedVehicleId: ids.seated } });
    await prisma.driver.create({ data: { workspaceId: W, name: "Sam South", terminal: "South", active: true, assignedVehicleId: ids.south } });
    await prisma.driver.create({ data: { workspaceId: W, name: "Old North", terminal: "North", active: false, assignedVehicleId: ids.benched } });
    const lead = await prisma.driver.create({ data: { workspaceId: W, name: "Lee Lead", terminal: "North", active: true, assignedVehicleId: ids.north } });

    // RDX North runs Dallas to Houston, due an hour ago: running late. A breadcrumb of three fixes.
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "RDX-RUN",
        status: "in_progress",
        vehicleId: ids.north,
        loadedMiles: 240,
        quotedRevenue: 900,
        originAddress: "Dallas, TX",
        destinationAddress: "Houston, TX",
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: "RDX Shipper", lat: 32.78, lng: -96.8, timeWindowLatest: new Date(NOW.getTime() - 6 * H) },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Houston, TX", facilityName: "RDX Receiver", lat: 29.76, lng: -95.37, timeWindowLatest: new Date(NOW.getTime() - H) }
          ]
        }
      }
    });
    ids.load = load.id;
    await prisma.assignment.create({ data: { loadId: load.id, driverId: lead.id, payKind: "per_mile", payRate: 0.6, status: "accepted" } });
    for (const [i, p] of [[32.5, -96.7], [32.0, -96.5], [31.5, -96.4]].entries()) await prisma.vehiclePing.create({ data: { workspaceId: W, vehicleId: ids.north, lat: p[0]!, lng: p[1]!, at: new Date(NOW.getTime() - (3 - i) * H) } });

    ids.hooked = (await prisma.trailer.create({ data: { workspaceId: W, number: "RDX-HOOKED", type: "dry_van", lengthFt: 53, terminal: "North", currentVehicleId: ids.north, lastLat: 31.5, lastLng: -96.4, lastLocatedAt: NOW } })).id;
    ids.longDrop = (await prisma.trailer.create({ data: { workspaceId: W, number: "RDX-LONG", type: "dry_van", lengthFt: 53, terminal: "North", lastLat: 32.8, lastLng: -96.9, lastLocatedAt: NOW, unhookedAt: new Date(NOW.getTime() - 60 * H) } })).id;
    ids.shortDrop = (await prisma.trailer.create({ data: { workspaceId: W, number: "RDX-SHORT", type: "dry_van", lengthFt: 53, terminal: "North", lastLat: 32.8, lastLng: -96.9, lastLocatedAt: NOW, unhookedAt: new Date(NOW.getTime() - 10 * H) } })).id;

    // Freight: two that need a driver (no assignment; a declined one), one sent to a driver (not open), one with no map point, one on a South truck (out of North's view).
    const stop = (lat: number | null, lng: number | null) => ({ create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Fort Worth, TX", lat, lng, timeWindowLatest: new Date(NOW.getTime() + 20 * H) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Austin, TX", lat: 30.27, lng: -97.74 }] });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "RDX-OPEN-1", status: "draft", quotedRevenue: 1200, loadedMiles: 200, trailerType: "dry_van", originAddress: "Fort Worth, TX", destinationAddress: "Austin, TX", stops: stop(32.75, -97.33) } });
    const declined = await prisma.load.create({ data: { workspaceId: W, loadNumber: "RDX-OPEN-2", status: "draft", quotedRevenue: 800, loadedMiles: 0, stops: stop(32.7, -97.2) } });
    await prisma.assignment.create({ data: { loadId: declined.id, driverId: lead.id, payKind: "per_mile", payRate: 0.6, status: "declined" } });
    const sent = await prisma.load.create({ data: { workspaceId: W, loadNumber: "RDX-SENT", status: "draft", stops: stop(32.7, -97.2) } });
    await prisma.assignment.create({ data: { loadId: sent.id, driverId: lead.id, payKind: "per_mile", payRate: 0.6, status: "dispatched" } });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "RDX-NOPOINT", status: "draft", stops: stop(null, null) } });
    const southTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "RDX South base", terminal: "South" } });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "RDX-SOUTHLOAD", status: "draft", vehicleId: southTruck.id, stops: stop(29.7, -95.3) } });
  });
  afterAll(async () => {
    await wipe(W);
  });

  test("a truck is in a terminal's view by its own terminal, or by the active driver seated in it", async () => {
    const north = await getRadarData(W, "North", NOW);
    const names = north.tractors.map((t) => t.name).sort();
    expect(names).toEqual(["RDX Idle", "RDX North", "RDX Seated"]);
    expect(names).not.toContain("RDX South-seated"); // seated, but its driver works out of South
    expect(names).not.toContain("RDX Benched"); // its North driver is not active
    const all = await getRadarData(W, null, NOW);
    expect(all.tractors.map((t) => t.name)).toEqual(expect.arrayContaining(["RDX North", "RDX Seated", "RDX South-seated", "RDX Benched", "RDX Idle"]));
  });

  test("the running truck's route: its lane, its breadcrumb and the card's live lines; the trailer it pulls answers the same load", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("no network in this test")));
    const r = await unitRoute("tractor", ids.north, W, "North", NOW);
    expect(r).toMatchObject({ mode: "route", status: "tracking", loadId: ids.load, loadNumber: "RDX-RUN", truckId: ids.north, late: true, driver: "Lee Lead", trailer: expect.stringContaining("RDX-HOOKED") });
    if (r.status === "none") throw new Error("no route");
    expect(r.stops.map((s) => s.role)).toEqual(["pickup", "delivery"]);
    expect(r.trail).toHaveLength(3);
    expect(r.headline).toContain("RUNNING LATE");
    expect(r.eta).toContain("RUNNING LATE");
    expect(r.nextStop).toBeTruthy();
    const viaTrailer = await unitRoute("trailer", ids.hooked, W, "North", NOW);
    expect(viaTrailer).toMatchObject({ status: "tracking", loadId: ids.load });
    // No load, another fleet's id, or a truck outside the view: nothing.
    expect(await unitRoute("tractor", ids.idle, W, "North", NOW)).toEqual({ mode: "route", status: "none" });
    expect(await unitRoute("tractor", ids.north, "rdx-nobody", null, NOW)).toEqual({ mode: "route", status: "none" });
    expect(await unitRoute("tractor", ids.south, W, "North", NOW)).toEqual({ mode: "route", status: "none" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("the exception chips: counts for the same search, and each narrows the points", async () => {
    const data = await getRadarData(W, "North", NOW);
    expect(data.tractors.find((t) => t.id === ids.north)?.late).toBe(true);
    const all = await radarPoints(data, q({}));
    // Late / alert: the late truck and the trailer past its free time (a dwell alert).
    expect(all.exceptions).toMatchObject({ late: 2, idling: 1, dropped_48: 1 });
    expect(all.exceptions.no_load).toBe(2); // RDX Idle and RDX Seated
    const names = async (x: string) => (await radarPoints(data, q({ x }))).points.map((p) => p.name).sort();
    expect(await names("late")).toEqual(["RDX North", "RDX-LONG"]);
    expect(await names("idling")).toEqual(["RDX Idle"]);
    expect(await names("no_load")).toEqual(["RDX Idle", "RDX Seated"]);
    expect(await names("dropped_48")).toEqual(["RDX-LONG"]);
    // The chip's counts do not move when a chip is chosen (they are for the search, the chip left out).
    expect((await radarPoints(data, q({ x: "idling" }))).exceptions).toEqual(all.exceptions);
  });

  test("open freight follows the header's needs-a-driver rule and scope, pinned at its first stop", async () => {
    const out = await radarOpenLoads(W, null, NOW);
    expect(out.pins.map((p) => p.number).sort()).toEqual(["RDX-OPEN-1", "RDX-OPEN-2", "RDX-SOUTHLOAD"]);
    expect(out.unplaced).toBe(1);
    const header = await prisma.load.count({ where: { workspaceId: W, deletedAt: null, AND: [inTerminal(null)], status: "draft", OR: [{ assignment: null }, { assignment: { status: { in: ["draft", "declined"] } } }] } });
    expect(out.pins.length + out.unplaced).toBe(header);
    const one = out.pins.find((p) => p.number === "RDX-OPEN-1")!;
    expect(one).toMatchObject({ lat: 32.75, lng: -97.33, lane: "Fort Worth, TX → Austin, TX", rate: "$1,200", rpm: "$6.00/mi", equipment: "dry_van" });
    expect(one.pickupDue).toBeTruthy();
    // North's view: the South truck's load is out; unplaced loads (no truck, no driver) are everyone's.
    const north = await radarOpenLoads(W, "North", NOW);
    expect(north.pins.map((p) => p.number).sort()).toEqual(["RDX-OPEN-1", "RDX-OPEN-2"]);
  });
});
