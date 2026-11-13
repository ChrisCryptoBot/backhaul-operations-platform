import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { calculateIfta } from "@/server/partners/ifta";
import { iftaQuarterMiles, syncIftaMileage } from "@/server/partners/ifta-mileage";
import { saveKeysAndConnect } from "@/server/partners/setup";

/**
 * Wave 5 step 5b: the routed all-miles fallback, from test keys (the simulators, network closed). Trucks the ELD did not report have their loads routed stop by stop with the empty legs between
 * them; routing again (twice in a row or two at once) never doubles a piece; ELD first on the write (a truck with ELD rows is never routed, and loses stale routed rows) and on the read (a
 * truck routed before its ELD read counts once, from the ELD).
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-routed.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "iroute-w";
const OTHER = "iroute-other";
const NO_ROUTER = "iroute-off";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "MOTIVE_API_KEY", "MOTIVE_WEBHOOK_SECRET", "PROMILES_API_KEY", "PROMILES_WEBHOOK_SECRET"];
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";

async function wipe() {
  for (const id of [W, OTHER, NO_ROUTER]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

const audits = () => prisma.auditEvent.findMany({ where: { workspaceId: W, action: "ifta_miles_routed" } });
const rows = (where: Prisma.IftaMileageWhereInput = {}) => prisma.iftaMileage.findMany({ where: { workspaceId: W, quarter: Q, ...where }, orderBy: [{ vehicleId: "asc" }, { startedAt: "asc" }, { externalId: "asc" }] });
const total = (xs: Array<{ miles: Prisma.Decimal }>) => xs.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0)).toFixed(1);

let truckA = "";
let truckB = "";
let truckC = "";
let loadA1 = "";
let loadA2 = "";

type StopIn = [string, string];
async function makeLoad(workspaceId: string, vehicleId: string, stops: StopIn[], delivered: string, loaded: number, dh = 0) {
  const l = await prisma.load.create({
    data: {
      workspaceId,
      vehicleId,
      status: "completed",
      originAddress: stops[0]![0],
      destinationAddress: stops[stops.length - 1]![0],
      loadedMiles: loaded,
      pickupDeadheadMiles: dh,
      completedAt: new Date(delivered),
      // Created out of order on purpose: routing follows stopSequence.
      stops: { create: stops.map(([place, when], i) => ({ stopSequence: i + 1, addressString: place, stopType: i === 0 ? "pickup" : "delivery", arrivedAt: new Date(when) })).reverse() }
    }
  });
  return l.id;
}

describe.skipIf(!run)("routed miles for trucks the ELD did not report", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("the desk tried to reach the network");
  });
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await wipe();
    for (const id of [W, OTHER, NO_ROUTER]) await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    expect(await saveKeysAndConnect("promiles", { PROMILES_API_KEY: "sandbox_promiles_0601" }, NOW, W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_0601" }, NOW, W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    expect(await saveKeysAndConnect("promiles", { PROMILES_API_KEY: "sandbox_promiles_0602" }, NOW, OTHER)).toMatchObject({ ok: true, sandbox: true, connected: true });

    truckA = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 201", homeBaseAddress: "Dallas, TX" } })).id;
    truckB = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 202" } })).id; // no home base
    truckC = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 203", homeBaseAddress: "Detroit, MI" } })).id;
    // A: a three-stop load, then an empty run Memphis to Nashville (the next load's 210 empty miles), then Nashville to Atlanta.
    loadA1 = await makeLoad(W, truckA, [["Dallas, TX", "2026-07-01T12:00:00Z"], ["Little Rock, AR", "2026-07-02T08:00:00Z"], ["Memphis, TN", "2026-07-02T18:00:00Z"]], "2026-07-02T19:00:00Z", 450);
    loadA2 = await makeLoad(W, truckA, [["Nashville, TN", "2026-07-04T10:00:00Z"], ["Atlanta, GA", "2026-07-04T18:00:00Z"]], "2026-07-04T18:30:00Z", 250, 210);
    // B: one load with 100 empty miles to the pickup and no home base to start from.
    await makeLoad(W, truckB, [["Tulsa, OK", "2026-08-01T12:00:00Z"], ["Dallas, TX", "2026-08-01T20:00:00Z"]], "2026-08-01T20:00:00Z", 260, 100);
    // C: into Canada.
    await makeLoad(W, truckC, [["Detroit, MI", "2026-08-05T12:00:00Z"], ["Toronto, ON", "2026-08-05T18:00:00Z"]], "2026-08-05T18:00:00Z", 230);
    const otherTruck = (await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "Unit 201" } })).id;
    await makeLoad(OTHER, otherTruck, [["Dallas, TX", "2026-07-15T10:00:00Z"], ["Houston, TX", "2026-07-15T16:00:00Z"]], "2026-07-15T16:00:00Z", 240);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await wipe();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a quarter is checked, and a desk with no router connected is told so and keeps nothing", async () => {
    expect(await calculateIfta("2026-Q5", W, NOW)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await calculateIfta(Q, NO_ROUTER, NOW)).toMatchObject({ ok: false, code: "not_configured" }); // no keys at all comes before "not connected"
    expect(await prisma.iftaMileage.count({ where: { workspaceId: NO_ROUTER } })).toBe(0);
  });

  test("the database refuses an ELD row with no odometer, and a method that is not one; a routed row needs none", async () => {
    const base = { workspaceId: W, vehicleId: truckA, quarter: Q, jurisdiction: "TX", source: "test", loaded: false, miles: 10, startedAt: new Date("2026-07-02T10:00:00Z"), endedAt: new Date("2026-07-02T11:00:00Z"), syncBatchId: "x", syncedAt: NOW };
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "d1", method: "eld" } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "d2", method: "guess" } })).rejects.toThrow();
    await prisma.iftaMileage.create({ data: { ...base, externalId: "d3", method: "routed" } });
    await prisma.iftaMileage.deleteMany({ where: { workspaceId: W, source: "test" } });
  });

  test("routing keeps each truck's legs stop by stop, loaded and empty, with no odometer, Canada counted and not kept", async () => {
    const out = await calculateIfta(Q, W, NOW);
    if (!out.ok) throw new Error(out.error);
    expect(out).toMatchObject({ provider: "promiles", quarter: Q, trucks: 3, eldTrucks: 0, replaced: 0, canadaMiles: "115.0", noStart: 1, unrouted: 0, notYet: 0 });
    const a = await rows({ vehicleId: truckA });
    // Dallas to Little Rock (no corridor: half TX, half AR), Little Rock to Memphis (AR, TN), the empty run Memphis to Nashville (all TN), Nashville to Atlanta (TN, GA).
    expect(a.map((r) => [r.jurisdiction, r.loaded, r.loadId === loadA1 ? "A1" : r.loadId === loadA2 ? "A2" : r.loadId])).toEqual([
      ["TX", true, "A1"],
      ["AR", true, "A1"],
      ["AR", true, "A1"],
      ["TN", true, "A1"],
      ["TN", false, null],
      ["TN", true, "A2"],
      ["GA", true, "A2"]
    ]);
    expect(total(a.filter((r) => r.loadId === loadA1))).toBe("450.0");
    expect(total(a.filter((r) => !r.loaded))).toBe("210.0");
    for (const r of a) expect(r).toMatchObject({ method: "routed", source: "promiles", startOdometer: null, endOdometer: null, syncBatchId: out.batchId, syncedAt: NOW });
    // B: its one load, and no empty leg made up (no home base).
    expect((await rows({ vehicleId: truckB })).map((r) => [r.jurisdiction, r.loaded])).toEqual([
      ["OK", true],
      ["TX", true]
    ]);
    // C: Michigan kept, Ontario counted only.
    expect((await rows({ vehicleId: truckC })).map((r) => [r.jurisdiction, r.miles.toFixed(1)])).toEqual([["MI", "115.0"]]);
    const [event] = await audits();
    expect(event!.summary).toContain("routed by ProMiles for 3 trucks without ELD miles");
    expect(event!.summary).toContain("115.0 miles in Canada not counted (gap 15)");
    expect(event!.summary).toContain("1 first load with no home base to start from");
    expect(await prisma.iftaMileage.count({ where: { workspaceId: OTHER } })).toBe(0);
  });

  test("routing again, or twice at once, leaves the same pieces", async () => {
    const before = await rows();
    const again = await calculateIfta(Q, W, NOW);
    expect(again).toMatchObject({ ok: true, replaced: before.length });
    expect((await rows()).map((r) => [r.externalId, r.miles.toFixed(1)])).toEqual(before.map((r) => [r.externalId, r.miles.toFixed(1)]));
    const [x, y] = await Promise.all([calculateIfta(Q, W, NOW), calculateIfta(Q, W, NOW)]);
    expect(x.ok && y.ok).toBe(true);
    const after = await rows();
    expect(after.map((r) => r.externalId)).toEqual(before.map((r) => r.externalId));
    expect(await audits()).toHaveLength(4);
  });

  test("ELD first on the read: a truck routed before its ELD read counts once, from the ELD", async () => {
    const routedBefore = (await iftaQuarterMiles(Q, W))!;
    expect(routedBefore.sources).toEqual([{ method: "routed", source: "promiles", trucks: 3 }]);
    const routedA = total(await rows({ vehicleId: truckA, method: "routed" }));
    const eld = await syncIftaMileage(Q, NOW, W);
    if (!eld.ok) throw new Error(eld.error);
    // The simulated ELD reports every truck with loads; keep only truck A's, as if the ELD reported A alone.
    await prisma.iftaMileage.deleteMany({ where: { workspaceId: W, method: "eld", vehicleId: { in: [truckB, truckC] } } });
    // The ELD read leaves the routed rows where they are; the reader sets A's aside.
    expect(await prisma.iftaMileage.count({ where: { workspaceId: W, quarter: Q, method: "routed", vehicleId: truckA } })).toBeGreaterThan(0);
    const q = (await iftaQuarterMiles(Q, W))!;
    expect(q.setAside).toBe(1);
    expect(q.sources).toEqual([
      { method: "eld", source: "motive", trucks: 1 },
      { method: "routed", source: "promiles", trucks: 2 }
    ]);
    const eldA = total(await rows({ vehicleId: truckA, method: "eld" }));
    const counted = new Prisma.Decimal(eldA).plus(total(await rows({ vehicleId: { in: [truckB, truckC] }, method: "routed" })));
    expect(q.miles).toBe(counted.toFixed(1));
    // Never A twice: the naive sum of every row is A's routed miles more.
    expect(new Prisma.Decimal(total(await rows())).minus(q.miles).toFixed(1)).toBe(routedA);
    expect(q.trucks.find((t) => t.vehicleId === truckA)).toMatchObject({ method: "eld", source: "motive", miles: eldA });
    expect(routedA).not.toBe("0.0");
  });

  test("ELD first on the write: routing again skips the ELD trucks and drops their stale routed rows", async () => {
    const out = await calculateIfta(Q, W, NOW);
    if (!out.ok) throw new Error(out.error);
    expect(out).toMatchObject({ eldTrucks: 1, trucks: 2 });
    for (const v of [truckA]) expect(await prisma.iftaMileage.count({ where: { workspaceId: W, quarter: Q, method: "routed", vehicleId: v } })).toBe(0);
    expect((await iftaQuarterMiles(Q, W))!.setAside).toBe(0);
    // The ELD rows are untouched by routing.
    expect((await rows({ method: "eld" })).length).toBeGreaterThan(0);
  });
});
