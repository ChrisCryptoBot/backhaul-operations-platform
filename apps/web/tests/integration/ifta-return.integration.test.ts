import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearFuelFlag } from "@/server/partners/fuel-flags";
import { iftaQuarterMiles } from "@/server/partners/ifta-mileage";
import { commitIftaRates, loadSampleIftaRates, clearIftaRates } from "@/server/partners/ifta-rates";
import { iftaReturn } from "@/server/partners/ifta-return";

/**
 * Wave 5 step 6: a quarter's return read from the database. Miles through the same ELD-first read as /ifta, fuel by `purchasedAt ?? postedAt` inside the quarter in the workspace's calendar,
 * settled road diesel only, the rate table, and an open fuel flag as a blocker until a person clears it. Nothing is written.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-return.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "iret-w";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3"; // 2026-07-01 05:00 UTC to 2026-10-01 05:00 UTC in Chicago

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let truckA = "";
let truckB = "";
let overfill = "";

const piece = (vehicleId: string, method: "eld" | "routed", source: string, jurisdiction: string, miles: number, n: number) => ({
  workspaceId: W,
  vehicleId,
  quarter: Q,
  jurisdiction,
  source,
  method,
  externalId: `${method}-${jurisdiction}-${n}`,
  loaded: true,
  startOdometer: method === "eld" ? 1000 * n : null,
  endOdometer: method === "eld" ? 1000 * n + miles : null,
  miles,
  startedAt: new Date("2026-08-01T10:00:00Z"),
  endedAt: new Date("2026-08-01T20:00:00Z"),
  syncBatchId: "b",
  syncedAt: NOW
});

let seq = 0;
const fill = (vehicleId: string | null, state: string | null, gallons: number, when: { purchasedAt?: string | null; postedAt: string }, over: Record<string, unknown> = {}) =>
  prisma.fuelTransaction.create({
    data: {
      workspaceId: W,
      provider: "csv",
      externalId: `f-${++seq}`,
      vehicleId,
      purchaseState: state,
      product: "road_diesel",
      status: "settled",
      taxPaid: true,
      gallons,
      pricePerGallon: 3.5,
      amount: gallons * 3.5,
      postedAt: new Date(when.postedAt),
      purchasedAt: when.purchasedAt ? new Date(when.purchasedAt) : null,
      ...over
    }
  });

describe.skipIf(!run)("the IFTA return from the records", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    truckA = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 501" } })).id;
    truckB = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 502", tankCapacityGallons: 100 } })).id;
    // A: ELD TX 1000 + OK 500, and stale routed TX 1200 that must be set aside. B: routed TX 600 + AR 400. Counted: TX 1600, OK 500, AR 400 = 2500.
    await prisma.iftaMileage.createMany({
      data: [piece(truckA, "eld", "motive", "TX", 1000, 1), piece(truckA, "eld", "motive", "OK", 500, 2), piece(truckA, "routed", "promiles", "TX", 1200, 3), piece(truckB, "routed", "promiles", "TX", 600, 4), piece(truckB, "routed", "promiles", "AR", 400, 5)]
    });
    // Counted fuel: A TX 200 tax paid; B AR 150 tax paid (no purchase moment: by its posted day; over B's 100-gallon tanks, so flagged); B TX 50 bulk. 400 gallons, MPG 6.25.
    await fill(truckA, "TX", 200, { purchasedAt: "2026-07-15T14:00:00Z", postedAt: "2026-07-15T12:00:00Z" });
    overfill = (await fill(truckB, "AR", 150, { postedAt: "2026-08-10T12:00:00Z" })).id;
    await fill(truckB, "TX", 50, { purchasedAt: "2026-09-01T12:00:00Z", postedAt: "2026-09-01T12:00:00Z" }, { taxPaid: false });
    // Not in the quarter: bought after it ends (posted the day before, in it), and bought late on June 30 Chicago time (July 1 in UTC).
    await fill(truckA, "TX", 70, { purchasedAt: "2026-10-01T06:00:00Z", postedAt: "2026-09-30T12:00:00Z" });
    await fill(truckA, "TX", 80, { purchasedAt: "2026-07-01T04:30:00Z", postedAt: "2026-07-01T12:00:00Z" });
    // In the quarter but not IFTA fuel, or not settled.
    await fill(truckA, "TX", 30, { purchasedAt: "2026-08-02T12:00:00Z", postedAt: "2026-08-02T12:00:00Z" }, { product: "reefer_diesel" });
    await fill(truckA, "TX", 5, { purchasedAt: "2026-08-02T13:00:00Z", postedAt: "2026-08-02T12:00:00Z" }, { product: "def" });
    await fill(truckA, "OK", 60, { purchasedAt: "2026-08-03T12:00:00Z", postedAt: "2026-08-03T12:00:00Z" }, { status: "pending" });
    await fill(truckA, "OK", 60, { purchasedAt: "2026-08-04T12:00:00Z", postedAt: "2026-08-04T12:00:00Z" }, { status: "declined" });
  });
  afterAll(wipe);

  test("a quarter is checked", async () => {
    expect(await iftaReturn("2026Q3", NOW, W)).toMatchObject({ ok: false, code: "bad_request" });
  });

  test("with no rates every state is blocked and nothing is guessed; the fleet numbers already stand", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ miles: "2500.0", gallons: "400.000", bulkGallons: "50.000", taxPaidGallons: "350.000", mpg: "6.25", total: null, rateCount: 0 });
    expect(r.blockers.find((b) => b.code === "missing_rate")!.items).toEqual(["AR", "OK", "TX"]);
    // The same counted miles /ifta shows.
    expect((await iftaQuarterMiles(Q, W))!.miles).toBe(r.miles);
    expect(r.notes).toEqual({ canadaGallons: "0.000", notFuel: 2, notSettled: 2 });
  });

  test("with the quarter's rates, an open flag still blocks; cleared, the return stands", async () => {
    expect(await commitIftaRates("Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nOklahoma,0.19,\nArkansas,0.285,", null, Q, "final", "q3.csv", NOW, W)).toMatchObject({ ok: true, created: 3 });
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    // TX 1600/6.25 = 256 taxable, 200 paid, 56 net × .20 = 11.20; OK 80 × .19 = 15.20; AR 64 − 150 = −86 × .285 = −24.51. Total 1.89.
    expect(r.lines.map((l) => [l.jurisdiction, l.taxableGallons, l.taxPaidGallons, l.netGallons, l.tax, l.total])).toEqual([
      ["AR", "64", "150", "-86", "-24.51", "-24.51"],
      ["OK", "80", "0", "80", "15.20", "15.20"],
      ["TX", "256", "200", "56", "11.20", "11.20"]
    ]);
    expect(r).toMatchObject({ tax: "1.89", surcharge: "0.00", total: "1.89", rateFinal: 3 });
    expect(r.blockers.map((b) => [b.code, b.items])).toEqual([["open_flags", [overfill]]]);
    // Per truck: A's ELD miles only (its routed TX 1200 set aside), B routed.
    expect(r.trucks.map((t) => [t.name, t.method, t.source, t.miles, t.gallons, t.mpg])).toEqual([
      ["Unit 501", "eld", "motive", "1500.0", "200.000", "7.50"],
      ["Unit 502", "routed", "promiles", "1000.0", "200.000", "5.00"]
    ]);
    expect(await clearFuelFlag(overfill, "over_capacity", "Saddle tanks added, 200 gallons", NOW, W)).toEqual({ ok: true });
    const cleared = await iftaReturn(Q, NOW, W);
    expect(cleared.ok && cleared.blockers).toEqual([]);
  });

  test("sample rates are a blocker; reading the return writes nothing", async () => {
    const before = await Promise.all([prisma.iftaMileage.count({ where: { workspaceId: W } }), prisma.auditEvent.count({ where: { workspaceId: W } })]);
    expect(await clearIftaRates(Q, NOW, W)).toMatchObject({ ok: true });
    expect(await loadSampleIftaRates(Q, NOW, W)).toMatchObject({ ok: true });
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    expect(r.blockers.map((b) => b.code)).toEqual(["sample_rates"]);
    expect(r.blockers[0]!.items).toEqual(["AR", "OK", "TX"]);
    await iftaReturn(Q, NOW, W);
    expect(await prisma.iftaMileage.count({ where: { workspaceId: W } })).toBe(before[0]);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W } })).toBe(before[1] + 2); // the clear and the sample load, nothing from the return
  });
});
