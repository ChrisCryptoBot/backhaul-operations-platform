import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { iftaQuarterMiles, syncIftaMileage } from "@/server/partners/ifta-mileage";
import { saveKeysAndConnect } from "@/server/partners/setup";

/**
 * Wave 5 step 5a: a quarter's ELD miles by state, from a test Motive key (the simulator, network closed). Loaded and empty pieces with odometers and times, a piece in the quarter it starts in,
 * Canada counted and not kept, a re-read (twice in a row or two at once) never doubling a piece, a truck the ELD said nothing for keeping what it had, one audit event per read.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-mileage.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "imiles-w";
const OTHER = "imiles-other";
const NOT_CONNECTED = "imiles-off";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "MOTIVE_API_KEY", "MOTIVE_WEBHOOK_SECRET"];
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";

async function wipe() {
  for (const id of [W, OTHER, NOT_CONNECTED]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

const audits = (workspaceId = W) => prisma.auditEvent.findMany({ where: { workspaceId, action: "ifta_miles_synced" }, orderBy: { createdAt: "asc" } });
const rows = (where: Prisma.IftaMileageWhereInput = {}) => prisma.iftaMileage.findMany({ where: { workspaceId: W, ...where }, orderBy: [{ vehicleId: "asc" }, { startedAt: "asc" }, { externalId: "asc" }] });
const total = (xs: Array<{ miles: Prisma.Decimal }>) => xs.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0)).toFixed(1);

let truckA = "";
let truckB = "";
let truckC = "";
let load1 = "";
let load2 = "";
let loadOver = "";
let loadCanada = "";

async function makeLoad(workspaceId: string, vehicleId: string, origin: string, destination: string, pickup: string, delivered: string, loaded: number, dh = 0, ret = 0) {
  const l = await prisma.load.create({
    data: {
      workspaceId,
      vehicleId,
      status: "completed",
      originAddress: origin,
      destinationAddress: destination,
      loadedMiles: loaded,
      pickupDeadheadMiles: dh,
      returnDeadheadMiles: ret,
      completedAt: new Date(delivered),
      stops: {
        create: [
          { stopSequence: 1, addressString: origin, stopType: "pickup", arrivedAt: new Date(pickup) },
          { stopSequence: 2, addressString: destination, stopType: "delivery", arrivedAt: new Date(delivered) }
        ]
      }
    }
  });
  return l.id;
}

describe.skipIf(!run)("ELD miles by state for a quarter", () => {
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
    for (const id of [W, OTHER, NOT_CONNECTED]) await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0501" }, NOW, W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0502" }, NOW, OTHER)).toMatchObject({ ok: true, sandbox: true, connected: true });

    truckA = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 101", homeBaseAddress: "Dallas, TX" } })).id;
    truckB = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 102", homeBaseAddress: "Detroit, MI" } })).id;
    truckC = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 103" } })).id; // no loads: the ELD says nothing for it
    load1 = await makeLoad(W, truckA, "Dallas, TX", "Atlanta, GA", "2026-07-10T14:00:00Z", "2026-07-11T22:00:00Z", 781, 42);
    load2 = await makeLoad(W, truckA, "Atlanta, GA", "Charlotte, NC", "2026-08-03T12:00:00Z", "2026-08-03T19:00:00Z", 244, 0);
    // Picked up on the quarter's last evening, delivered in Q4 (the quarter ends 2026-10-01 05:00 UTC in Chicago).
    loadOver = await makeLoad(W, truckA, "Dallas, TX", "Atlanta, GA", "2026-09-30T20:00:00Z", "2026-10-01T20:00:00Z", 780, 0, 790);
    loadCanada = await makeLoad(W, truckB, "Detroit, MI", "Toronto, ON", "2026-08-01T12:00:00Z", "2026-08-01T18:00:00Z", 230, 0);
    // A Q3 load in another desk, which a read here must never touch.
    const otherTruck = (await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "Unit 101" } })).id;
    await makeLoad(OTHER, otherTruck, "Dallas, TX", "Houston, TX", "2026-07-15T10:00:00Z", "2026-07-15T16:00:00Z", 240);
    // What truck C had from an earlier read: a truck the ELD answers nothing for keeps it.
    await prisma.iftaMileage.create({
      data: { workspaceId: W, vehicleId: truckC, quarter: Q, jurisdiction: "OK", source: "motive", externalId: "earlier-1:OK", loaded: false, startOdometer: 10, endOdometer: 60, miles: 50, startedAt: new Date("2026-07-02T10:00:00Z"), endedAt: new Date("2026-07-02T11:00:00Z"), syncBatchId: "earlier", syncedAt: new Date("2026-10-02T00:00:00Z") }
    });
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

  test("a quarter is checked, and a desk with no ELD connected is told so and keeps nothing", async () => {
    for (const bad of ["2026Q3", "2026-Q5", "", "2026-Q3; drop"]) expect(await syncIftaMileage(bad, NOW, W)).toMatchObject({ ok: false, error: "A quarter, like 2026-Q3." });
    expect(await syncIftaMileage(Q, NOW, NOT_CONNECTED)).toMatchObject({ ok: false });
    expect(await prisma.iftaMileage.count({ where: { workspaceId: NOT_CONNECTED } })).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  test("the database refuses a bad row whatever the code does", async () => {
    const base = { workspaceId: W, vehicleId: truckA, quarter: Q, jurisdiction: "TX", source: "test", loaded: false, startOdometer: 10, endOdometer: 20, miles: 10, startedAt: new Date("2026-07-02T10:00:00Z"), endedAt: new Date("2026-07-02T11:00:00Z"), syncBatchId: "x", syncedAt: NOW };
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c1", quarter: "2026Q3" } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c2", jurisdiction: "ON" } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c3", endOdometer: 5 } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c4", miles: -1 } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c5", endedAt: new Date("2026-07-02T09:00:00Z") } })).rejects.toThrow();
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c6", loadId: load1, loaded: false } })).rejects.toThrow();
    await prisma.iftaMileage.create({ data: { ...base, externalId: "c7" } });
    await expect(prisma.iftaMileage.create({ data: { ...base, externalId: "c7" } })).rejects.toThrow(); // the unique key
    await prisma.iftaMileage.deleteMany({ where: { workspaceId: W, source: "test" } });
  });

  test("a read keeps every US piece, loaded and empty, with odometers and times; Canada is counted and not kept", async () => {
    const out = await syncIftaMileage(Q, NOW, W);
    if (!out.ok) throw new Error(out.error);
    expect(out).toMatchObject({ provider: "motive", quarter: Q, trucks: 2, notAnswered: 1, replaced: 0, canadaMiles: "115.0" });
    const a = await rows({ vehicleId: truckA });
    const b = await rows({ vehicleId: truckB });
    expect(out.pieces).toBe(a.length + b.length);
    expect(out.miles).toBe(total([...a, ...b]));
    // Truck A: the empty run to load 1 (Texas), load 1 over TX>GA, load 2 over GA>NC, and the part of the boundary load that starts in Q3 (TX, LA).
    expect(a.map((r) => [r.jurisdiction, r.loaded, r.loadId === load1 ? "load1" : r.loadId === load2 ? "load2" : r.loadId === loadOver ? "over" : r.loadId])).toEqual([
      ["TX", false, null],
      ["TX", true, "load1"],
      ["LA", true, "load1"],
      ["MS", true, "load1"],
      ["AL", true, "load1"],
      ["GA", true, "load1"],
      ["GA", true, "load2"],
      ["SC", true, "load2"],
      ["NC", true, "load2"],
      ["TX", true, "over"],
      ["LA", true, "over"]
    ]);
    expect(total(a.filter((r) => r.loadId === load1))).toBe("781.0");
    expect(total(a.filter((r) => !r.loaded))).toBe("42.0");
    expect(out.loadedMiles).toBe(total([...a, ...b].filter((r) => r.loaded)));
    expect(out.emptyMiles).toBe("42.0");
    // The odometer runs on piece to piece, and a piece's miles are its odometer's.
    for (let i = 1; i < a.length; i++) expect(a[i]!.startOdometer!.toFixed(1)).toBe(a[i - 1]!.endOdometer!.toFixed(1));
    for (const r of a) {
      expect(r.endOdometer!.minus(r.startOdometer!).toFixed(1)).toBe(r.miles.toFixed(1));
      expect(r.endedAt.getTime()).toBeGreaterThan(r.startedAt.getTime());
      expect(r.startedAt.getTime()).toBeLessThan(new Date("2026-10-01T05:00:00Z").getTime());
      expect(r).toMatchObject({ quarter: Q, source: "motive", syncBatchId: out.batchId, syncedAt: NOW });
    }
    // Truck B's Detroit to Toronto run: half in Michigan, kept; half in Ontario, counted and not kept.
    expect(b.map((r) => [r.jurisdiction, r.miles.toFixed(1), r.loadId === loadCanada])).toEqual([["MI", "115.0", true]]);
    // Truck C keeps what it had.
    expect((await rows({ vehicleId: truckC })).map((r) => r.externalId)).toEqual(["earlier-1:OK"]);

    const [event] = await audits();
    expect(event).toBeTruthy();
    expect(event!.summary).toContain(`${Q} ELD miles read from Motive`);
    expect(event!.summary).toContain("115.0 miles in Canada not counted (gap 15)");
    expect(event!.summary).toContain("1 truck with no ELD miles");
    expect(event!.after).toMatchObject({ Quarter: Q, Trucks: "2", "No ELD miles": "1", Pieces: String(out.pieces), Miles: out.miles, "Canada, not counted (gap 15)": "115.0" });
    // Another desk's quarter is untouched.
    expect(await prisma.iftaMileage.count({ where: { workspaceId: OTHER } })).toBe(0);
  });

  test("reading the same quarter again replaces it: no doubled piece, the same ids, one more audit event", async () => {
    const before = await rows();
    const out = await syncIftaMileage(Q, NOW, W);
    if (!out.ok) throw new Error(out.error);
    const after = await rows();
    expect(out.replaced).toBe(before.length - 1); // all of A and B's pieces; C's earlier row is not theirs
    expect(after.map((r) => r.externalId)).toEqual(before.map((r) => r.externalId));
    expect(after.map((r) => r.miles.toFixed(1))).toEqual(before.map((r) => r.miles.toFixed(1)));
    expect(new Set(after.map((r) => r.syncBatchId))).toEqual(new Set([out.batchId, "earlier"]));
    expect(await audits()).toHaveLength(2);
  });

  test("two reads at once leave one set of pieces", async () => {
    const count = await prisma.iftaMileage.count({ where: { workspaceId: W } });
    const [x, y] = await Promise.all([syncIftaMileage(Q, NOW, W), syncIftaMileage(Q, NOW, W)]);
    expect(x.ok && y.ok).toBe(true);
    expect(await prisma.iftaMileage.count({ where: { workspaceId: W } })).toBe(count);
    const ids = (await rows()).map((r) => r.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await audits()).toHaveLength(4);
  });

  test("the next quarter takes the boundary load's pieces that start in it, up to the desk's clock, and Q3 keeps its own", async () => {
    const q3 = (await rows({ quarter: Q })).map((r) => r.externalId);
    const out = await syncIftaMileage("2026-Q4", NOW, W);
    if (!out.ok) throw new Error(out.error);
    const q4 = await rows({ quarter: "2026-Q4" });
    expect(q4.length).toBeGreaterThan(0);
    expect(q4.filter((r) => r.loadId === loadOver).map((r) => r.jurisdiction)).toEqual(["MS", "AL", "GA"]);
    // The run home after the boundary load (Atlanta to Dallas, back down the corridor) is empty, and in Q4.
    expect(q4.filter((r) => !r.loaded).length).toBeGreaterThan(0);
    for (const r of q4) {
      expect(r.startedAt.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-01T05:00:00Z").getTime());
      expect(r.endedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
    expect(total(q4.filter((r) => r.loadId === loadOver)) !== "0.0").toBe(true);
    expect((await rows({ quarter: Q })).map((r) => r.externalId)).toEqual(q3);
    expect(q4.some((r) => q3.includes(r.externalId))).toBe(false);
    // The boundary load's miles are all kept once, across the two quarters.
    expect(total(await rows({ loadId: loadOver }))).toBe("780.0");
  });

  test("a removed load leaves its pieces loaded with no load, and the summary says what each quarter holds", async () => {
    await prisma.load.delete({ where: { id: load2 } });
    const orphaned = await rows({ quarter: Q, loaded: true, loadId: null });
    expect(orphaned.map((r) => r.jurisdiction)).toEqual(["GA", "SC", "NC"]);
    const s = (await iftaQuarterMiles(Q, W))!;
    const all = await rows({ quarter: Q, source: "motive" });
    expect(s).toMatchObject({ sources: [{ method: "eld", source: "motive", trucks: 3 }], setAside: 0, pieces: all.length, miles: total(all), syncedAt: NOW });
    expect(new Prisma.Decimal(s.loadedMiles).plus(s.emptyMiles).toFixed(1)).toBe(s.miles);
    expect(await iftaQuarterMiles("not a quarter", W)).toBeNull();
  });
});
