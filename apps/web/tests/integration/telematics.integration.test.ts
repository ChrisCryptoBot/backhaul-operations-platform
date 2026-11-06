import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { importEldFleet } from "@/server/partners/eld-import";
import { syncEld } from "@/server/partners/eld";
import { purgeOldPings } from "@/server/partners/retention";
import { saveKeysAndConnect } from "@/server/partners/setup";
import { listEntityAudit } from "@/server/tl/audit";
import { adjustTrailerDwell, clearTrailerDwell, waiveTrailerDwell } from "@/server/tl/dwell";
import { getLoadTracking } from "@/server/tl/load-tracking";
import { getRadarData } from "@/server/tl/radar";
import { hookTrailer, listTrailersPage } from "@/server/tl/trailers";

/**
 * The telematics layer on the demo database, in workspaces of its own and with the network closed: one-click fleet import from a test ELD key, positions and pings, a trailer riding with its
 * tractor, the radar's data scoped to one fleet, a load's tracking, and a dropped trailer's dwell that a dispatcher or billing person can type over or waive.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/telematics.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "tel-radar";
const SMALL = "tel-small";
const OTHER = "tel-other";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "MOTIVE_API_KEY", "MOTIVE_WEBHOOK_SECRET"];
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-05T17:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const DALLAS = { lat: 32.7767, lng: -96.797 };
const ATLANTA = { lat: 33.749, lng: -84.388 };

describe.skipIf(!run)("telematics: radar, idle, dwell, onboarding", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("the desk tried to reach the network");
  });
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const id of [W, SMALL, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: SMALL, name: SMALL, plan: "starter" } });
    await prisma.workspace.create({ data: { id: OTHER, name: OTHER, plan: "enterprise" } });
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.workspace.deleteMany({ where: { id: { in: [W, SMALL, OTHER] } } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a test key and one import adds the company's trucks and drivers, paired, with VINs, codes and positions, and a second run adds nothing", async () => {
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0001" }, NOW, W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    const out = await importEldFleet(NOW, W);
    expect(out).toMatchObject({ ok: true, provider: "motive", trucks: 8, drivers: 8, skippedTrucks: 0, skippedDrivers: 0, onMap: 8 });
    const trucks = await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } });
    expect(trucks.map((t) => t.name)).toEqual(["Unit 301", "Unit 302", "Unit 303", "Unit 304", "Unit 305", "Unit 306", "Unit 307", "Unit 308"]);
    for (const t of trucks) {
      expect(t.vin).toHaveLength(17);
      expect(t.make).toBeTruthy();
      expect(t.eldVehicleId).toBeTruthy();
      expect(t.lastLat).not.toBeNull(); // on the map at once
      expect(t.engineState).toMatch(/^(moving|idle|off)$/);
    }
    const drivers = await prisma.driver.findMany({ where: { workspaceId: W } });
    expect(drivers).toHaveLength(8);
    expect(new Set(drivers.map((d) => d.code)).size).toBe(8); // codes from the shifts work, unique
    for (const d of drivers) {
      expect(d.licenseNumber).toMatch(/^[A-Z]{2}-/);
      expect(d.assignedVehicleId).toBeTruthy(); // each driver on their own truck
      expect(d.hosDriveMinutes).toBeGreaterThan(0);
    }
    expect((await listEntityAudit("", 1, W).catch(() => [])).length).toBeGreaterThanOrEqual(0);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "eld_fleet_imported" } })).toBe(1);
    expect(await importEldFleet(NOW, W)).toMatchObject({ ok: true, trucks: 0, drivers: 0 });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(8);
    // Another fleet is untouched.
    expect(await prisma.vehicle.count({ where: { workspaceId: OTHER } })).toBe(0);
  });

  test("an import is held to the plan: a Starter fleet gets what fits and is told how many were left out", async () => {
    await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0002" }, NOW, SMALL);
    const out = await importEldFleet(NOW, SMALL);
    expect(out).toMatchObject({ ok: true, trucks: 3, skippedTrucks: 5 });
    if (out.ok) expect(out.drivers + out.skippedDrivers).toBe(8);
    expect(await prisma.vehicle.count({ where: { workspaceId: SMALL } })).toBe(3);
  });

  test("an import never overwrites what the desk has: a truck already named Unit 301 is left alone", async () => {
    await prisma.workspace.create({ data: { id: `${W}-b`, name: "b", plan: "enterprise" } });
    try {
      await prisma.vehicle.create({ data: { workspaceId: `${W}-b`, name: "Unit 301", make: "My own make", mpg: 7.5 } });
      await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0003" }, NOW, `${W}-b`);
      expect(await importEldFleet(NOW, `${W}-b`)).toMatchObject({ ok: true, trucks: 7 });
      const mine = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: `${W}-b`, name: "Unit 301" } });
      expect(mine.make).toBe("My own make");
      expect(Number(mine.mpg)).toBe(7.5);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: `${W}-b` } });
    }
  });

  test("every read keeps the fix once: a re-read of the same instant writes nothing, a later one adds a ping, and old pings are purged after a week", async () => {
    const before = await prisma.vehiclePing.count({ where: { workspaceId: W } });
    expect(before).toBeGreaterThan(0);
    await syncEld(NOW, W);
    expect(await prisma.vehiclePing.count({ where: { workspaceId: W } })).toBe(before);
    await syncEld(new Date(NOW.getTime() + 20 * 60_000), W);
    expect(await prisma.vehiclePing.count({ where: { workspaceId: W } })).toBeGreaterThan(before);
    const truck = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W } });
    await prisma.vehiclePing.create({ data: { workspaceId: W, vehicleId: truck.id, lat: 33, lng: -96, at: new Date(NOW.getTime() - 9 * 86_400_000) } });
    expect(await purgeOldPings(NOW)).toBeGreaterThanOrEqual(1);
    expect(await prisma.vehiclePing.count({ where: { workspaceId: W, at: { lt: new Date(NOW.getTime() - 7 * 86_400_000) } } })).toBe(0);
  });

  test("a trailer hooked to a tractor is where the tractor is; dropped, it stays where it was left and its dwell clock starts", async () => {
    const trucks = await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } });
    const t1 = trucks[0]!;
    const tr = await prisma.trailer.create({ data: { workspaceId: W, number: "TEL-1", type: "dry_van", lengthFt: 53 } });
    expect(await hookTrailer(tr.id, t1.id, NOW, W)).toEqual({ ok: true });
    await syncEld(new Date(NOW.getTime() + 40 * 60_000), W);
    const truck = await prisma.vehicle.findUniqueOrThrow({ where: { id: t1.id } });
    const hooked = await prisma.trailer.findUniqueOrThrow({ where: { id: tr.id } });
    expect(hooked.hookedAt).not.toBeNull();
    expect(hooked.unhookedAt).toBeNull();
    expect(Number(hooked.lastLat)).toBeCloseTo(Number(truck.lastLat), 5);
    const dropAt = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(await hookTrailer(tr.id, null, dropAt, W)).toEqual({ ok: true });
    const dropped = await prisma.trailer.findUniqueOrThrow({ where: { id: tr.id } });
    expect(dropped.unhookedAt?.toISOString()).toBe(dropAt.toISOString());
    expect(dropped.currentVehicleId).toBeNull();
    expect(Number(dropped.lastLat)).toBeCloseTo(Number(truck.lastLat), 5); // where the tractor left it
  });

  test("the radar's data is this fleet's alone, counts what it shows, and words an idling truck in gallons and dollars", async () => {
    const trucks = await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } });
    const idler = trucks[1]!;
    await prisma.costProfile.upsert({ where: { vehicleId: idler.id }, create: { vehicleId: idler.id, estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85, lastFuelPricePerGallon: 3.96 }, update: { lastFuelPricePerGallon: 3.96 } });
    await prisma.vehicle.update({ where: { id: idler.id }, data: { engineState: "idle", lastSpeedMph: 0, idleSince: new Date(NOW.getTime() - (3 * 60 + 14) * 60_000), idleHoursToday: 3.4 } });
    const data = await getRadarData(W, null, NOW);
    expect(data.connected).toBe(true);
    expect(data.counts.tractors).toBe(8);
    expect(data.tractors).toHaveLength(8);
    const row = data.tractors.find((t) => t.id === idler.id)!;
    expect(row.state).toBe("idling");
    expect(row.idle?.sentence).toBe("IDLING (Stationary 3h 14m) · Burned: 3.2 gal · Cash Lost: −$12.80");
    expect(row.idle?.todayHours).toBe(3.4);
    expect(data.counts.idling).toBeGreaterThanOrEqual(1);
    // Nothing of this fleet reaches another, and a terminal scope narrows it.
    expect((await getRadarData(OTHER, null, NOW)).tractors).toHaveLength(0);
    expect((await getRadarData(W, "Nowhere", NOW)).tractors).toHaveLength(0);
  });

  test("a load's tracking: the lane, the truck's breadcrumb, miles and ETA, on schedule or late, and the geofence at the receiver", async () => {
    const truck = (await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } }))[2]!;
    const stops = (pick: Date, drop: Date) => ({
      create: [
        { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: "Dallas Distribution", lat: DALLAS.lat, lng: DALLAS.lng, timeWindowEarliest: pick, timeWindowLatest: pick },
        { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", facilityName: "Atlanta Receiving", lat: ATLANTA.lat, lng: ATLANTA.lng, timeWindowEarliest: drop, timeWindowLatest: drop }
      ]
    });
    const load = await prisma.load.create({ data: { workspaceId: W, loadNumber: "TEL-L1", status: "in_progress", quotedRevenue: 2000, loadedMiles: 781, vehicleId: truck.id, stops: stops(new Date(NOW.getTime() - 5 * 3_600_000), new Date(NOW.getTime() + 40 * 3_600_000)) } });
    // Read the ELD: the simulator puts the truck on this load's lane.
    expect(await syncEld(NOW, W)).toMatchObject({ ok: true });
    let t = await getLoadTracking(load.id, W, NOW);
    expect(t.status).toBe("tracking");
    if (t.status !== "tracking") return;
    expect(t.stops.map((s) => s.role)).toEqual(["pickup", "delivery"]);
    expect(t.headline).toMatch(/miles to destination · ETA .* CT · ON SCHEDULE$/);
    expect(t.late).toBe(false);
    expect(t.trail.length).toBeGreaterThanOrEqual(1);
    expect(t.geofences).toEqual([]);

    // The same truck a long way from done with a window that closes in an hour: running late.
    await prisma.stop.updateMany({ where: { loadId: load.id, stopType: "delivery" }, data: { timeWindowLatest: new Date(NOW.getTime() + 3_600_000), timeWindowEarliest: new Date(NOW.getTime() + 3_600_000) } });
    await prisma.vehicle.update({ where: { id: truck.id }, data: { lastLat: DALLAS.lat + 0.4, lastLng: DALLAS.lng + 0.4, lastSpeedMph: 62, lastHeadingDeg: 90, engineState: "moving", lastLocatedAt: NOW } });
    t = await getLoadTracking(load.id, W, NOW);
    expect(t.status === "tracking" && t.late).toBe(true);
    if (t.status === "tracking") expect(t.headline).toMatch(/RUNNING LATE$/);

    // At the receiver, inside a mile: the geofence line, with the time the truck first got there, and no ETA.
    await prisma.vehicle.update({ where: { id: truck.id }, data: { lastLat: ATLANTA.lat + 0.004, lastLng: ATLANTA.lng, lastSpeedMph: 0, engineState: "idle", lastLocatedAt: NOW } });
    await prisma.vehiclePing.create({ data: { workspaceId: W, vehicleId: truck.id, lat: ATLANTA.lat + 0.004, lng: ATLANTA.lng, speedMph: 0, engine: "idle", at: new Date(NOW.getTime() + 2_000) } });
    t = await getLoadTracking(load.id, W, NOW);
    expect(t.status).toBe("tracking");
    if (t.status !== "tracking") return;
    expect(t.geofences).toHaveLength(1);
    expect(t.geofences[0]).toMatchObject({ stop: 2, inside: true });
    expect(t.geofences[0]!.text).toMatch(/^GEOFENCE: AT RECEIVER FACILITY \(\d{2}:\d{2} CT\)$/);
    expect(t.headline).toContain("AT THE DESTINATION");
    // It shows; it writes nothing: the stop's arrival is still blank.
    expect((await prisma.stop.findFirstOrThrow({ where: { loadId: load.id, stopType: "delivery" } })).arrivedAt).toBeNull();
  });

  test("a load with no truck, no lane or no position says so rather than drawing nothing", async () => {
    const bare = await prisma.load.create({ data: { workspaceId: W, loadNumber: "TEL-L2", status: "draft", quotedRevenue: 900 } });
    expect(await getLoadTracking(bare.id, W, NOW)).toEqual({ status: "no_truck" });
    const t = (await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } }))[3]!;
    const noLane = await prisma.load.create({ data: { workspaceId: W, loadNumber: "TEL-L3", status: "accepted", quotedRevenue: 900, vehicleId: t.id } });
    expect(await getLoadTracking(noLane.id, W, NOW)).toMatchObject({ status: "no_lane" });
    expect(await getLoadTracking(noLane.id, OTHER, NOW)).toEqual({ status: "no_truck" }); // another fleet cannot read it
  });

  describe("a dropped trailer's dwell can always be typed over or waived by a person", () => {
    let trailerId = "";
    let otherTrailer = "";
    const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
    const row = async (now = NOW) => (await listTrailersPage({ q: "DW-1" }, now, W)).rows[0]!;

    beforeAll(async () => {
      const dropped = new Date(NOW.getTime() - 4.2 * 86_400_000);
      trailerId = (await prisma.trailer.create({ data: { workspaceId: W, number: "DW-1", type: "dry_van", unhookedAt: dropped, lastLat: 32.8, lastLng: -96.8, lastLocatedAt: dropped } })).id;
      otherTrailer = (await prisma.trailer.create({ data: { workspaceId: OTHER, number: "DW-X", type: "dry_van", unhookedAt: dropped } })).id;
    });

    test("the company's terms are the start: 4.2 days sitting, 48 hours free, $75 a day is $165.00 and an alert", async () => {
      const r = await row();
      expect(r.dwell).toMatchObject({ alert: true, amount: 165, source: { days: "company", rate: "company" } });
    });

    test("a company that changes its terms in Rules changes the figure", async () => {
      await prisma.workspace.update({ where: { id: W }, data: { dwellFreeHours: 24, dwellPerDayRate: 100 } });
      expect((await row()).dwell?.amount).toBe(320);
      await prisma.workspace.update({ where: { id: W }, data: { dwellFreeHours: null, dwellPerDayRate: null } });
      expect((await row()).dwell?.amount).toBe(165);
    });

    test("a typed rate wins over the company's, is marked typed, and is audited before and after with who typed it", async () => {
      expect(await adjustTrailerDwell(trailerId, { ratePerDay: "100", note: "Customer agreed $100" }, NOW, W)).toEqual({ ok: true });
      const r = await row();
      expect(r.dwell).toMatchObject({ amount: 220, rate: 100, computedAmount: 165, source: { days: "company", rate: "typed" } });
      expect(r.dwellTyped).toMatchObject({ rate: 100, days: null, waived: false, note: "Customer agreed $100" });
      expect(r.dwellTyped.by).toBeTruthy();
      const entry = (await listEntityAudit(trailerId, 5, W))[0]!;
      expect(entry).toMatchObject({ action: "dwell_adjusted", reason: "Customer agreed $100" });
      expect(entry.before).toMatchObject({ "Rate a day": "Company rate", Owed: "$165.00" });
      expect(entry.after).toMatchObject({ "Rate a day": "$100.00", Owed: "$220.00" });
    });

    test("typed billable days win over the computed days, alone or with a rate", async () => {
      expect(await adjustTrailerDwell(trailerId, { billableDays: "1" }, NOW, W)).toEqual({ ok: true });
      expect((await row()).dwell).toMatchObject({ amount: 75, source: { days: "typed", rate: "company" } });
      expect(await adjustTrailerDwell(trailerId, { ratePerDay: "60", billableDays: "3" }, NOW, W)).toEqual({ ok: true });
      expect((await row()).dwell).toMatchObject({ amount: 180, source: { days: "typed", rate: "typed" } });
    });

    test("the typed figure stands as time passes: only the computed one beside it moves", async () => {
      const r = await row(later(24));
      expect(r.dwell?.amount).toBe(180); // typed days and rate: unchanged a day on
      expect(r.dwell?.computedAmount).toBeGreaterThan(165);
    });

    test("the whole fee can be waived, with a note, and the figure it would have been is kept", async () => {
      expect(await waiveTrailerDwell(trailerId, "Customer's fault, free", NOW, W)).toEqual({ ok: true });
      const r = await row();
      expect(r.dwell).toMatchObject({ amount: 0, waived: true });
      expect(r.dwellTyped).toMatchObject({ waived: true, note: "Customer's fault, free" });
      expect((await listEntityAudit(trailerId, 1, W))[0]).toMatchObject({ action: "dwell_waived" });
      expect(await waiveTrailerDwell(trailerId, null, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/already waived/) });
    });

    test("adjusting after a waiver lifts it; clearing goes back to the company's figure", async () => {
      expect(await adjustTrailerDwell(trailerId, { ratePerDay: "50" }, NOW, W)).toEqual({ ok: true });
      expect((await row()).dwell).toMatchObject({ waived: false, amount: 110 });
      expect(await clearTrailerDwell(trailerId, NOW, W)).toEqual({ ok: true });
      const r = await row();
      expect(r.dwell).toMatchObject({ amount: 165, source: { days: "company", rate: "company" } });
      expect(r.dwellTyped).toMatchObject({ rate: null, days: null, waived: false, note: null });
      expect((await listEntityAudit(trailerId, 1, W))[0]).toMatchObject({ action: "dwell_reset" });
      expect(await clearTrailerDwell(trailerId, NOW, W)).toEqual({ ok: true }); // nothing to clear is not an error
    });

    test("bad figures are refused with the problem in words, and nothing is saved", async () => {
      for (const bad of [{ ratePerDay: "abc" }, { ratePerDay: "-5" }, { ratePerDay: "1000.01" }, { ratePerDay: "12.345" }, { billableDays: "366" }, { billableDays: "1e3" }]) {
        expect(await adjustTrailerDwell(trailerId, bad, NOW, W), JSON.stringify(bad)).toMatchObject({ ok: false });
      }
      expect(await adjustTrailerDwell(trailerId, {}, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/rate a day, the billable days, or both/) });
      expect(await adjustTrailerDwell(trailerId, { ratePerDay: "$80.50" }, NOW, W)).toEqual({ ok: true }); // a dollar sign and cents are fine
      expect((await row()).dwell?.rate).toBe(80.5);
      await clearTrailerDwell(trailerId, NOW, W);
    });

    test("another fleet's trailer is not found, never changed", async () => {
      expect(await adjustTrailerDwell(otherTrailer, { ratePerDay: "10" }, NOW, W)).toEqual({ ok: false, error: "That trailer is not available." });
      expect(await waiveTrailerDwell(otherTrailer, null, NOW, W)).toEqual({ ok: false, error: "That trailer is not available." });
      expect((await prisma.trailer.findUniqueOrThrow({ where: { id: otherTrailer } })).dwellRateOverride).toBeNull();
    });

    test("a hooked trailer has no dwell to type over", async () => {
      const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "DW Truck" } });
      const hooked = await prisma.trailer.create({ data: { workspaceId: W, number: "DW-2", currentVehicleId: truck.id } });
      expect(await adjustTrailerDwell(hooked.id, { ratePerDay: "10" }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/not dwelling/) });
    });

    test("hooking the trailer again ends the stay: the typed figure is cleared, and the audit trail keeps what it was", async () => {
      expect(await adjustTrailerDwell(trailerId, { ratePerDay: "90", billableDays: "2" }, NOW, W)).toEqual({ ok: true });
      const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "DW Truck 2" } });
      expect(await hookTrailer(trailerId, truck.id, NOW, W)).toEqual({ ok: true });
      const t = await prisma.trailer.findUniqueOrThrow({ where: { id: trailerId } });
      expect(t).toMatchObject({ unhookedAt: null, dwellRateOverride: null, dwellDaysOverride: null, dwellWaived: false, dwellOverrideNote: null });
      const reset = (await listEntityAudit(trailerId, 50, W)).find((a) => a.action === "dwell_reset")!;
      expect(reset.before).toMatchObject({ Rate: "90", Days: "2" });
    });
  });
});
