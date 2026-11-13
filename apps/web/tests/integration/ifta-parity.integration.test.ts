import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/import-csv";
import { roundGallons, returnDrift } from "@/lib/ifta-return";
import { fileIftaReturn, iftaFiling } from "@/server/partners/ifta-filing";
import { iftaQuarterMiles } from "@/server/partners/ifta-mileage";
import { commitIftaRates } from "@/server/partners/ifta-rates";
import { iftaReturn, iftaReturnDetail } from "@/server/partners/ifta-return";
import { buildExport } from "@/server/tl/exports";

/**
 * Wave 5 step 9, parity: one quarter, every way it is read. The return's lines add up to its totals; the trucks add up to the return (miles by state, gallons, tax-paid gallons by state); the
 * mileage summary, the return CSV and the audit CSV say the same; each truck's audit pieces and receipts add up to its line; and once filed, the snapshot is the return and drifts only when a
 * record changes. Three trucks (two ELD, one routed, one with set-aside routed rows), five states, tax-paid, bulk, reefer and pending fills.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-parity.integration.test.ts
 */
const W = "ipar-w";
vi.mock("@/server/tl/workspace", async (orig) => ({ ...(await orig<typeof import("@/server/tl/workspace")>()), currentWorkspaceId: () => W }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v === "" ? 0 : v);
const sum = <T>(xs: readonly T[], f: (x: T) => Prisma.Decimal.Value) => xs.reduce((s, x) => s.plus(f(x)), D(0));
const rows = (csv: string) => parseCsv(csv.slice(1)).filter((r) => r.some((c) => c !== ""));

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let t1 = "";
let t2 = "";
let t3 = "";
let seq = 0;
let n = 0;
const piece = (vehicleId: string, method: "eld" | "routed", jurisdiction: string, miles: number, loaded = true) => {
  n += 1;
  return {
    workspaceId: W,
    vehicleId,
    quarter: Q,
    jurisdiction,
    source: method === "eld" ? "motive" : "promiles",
    method,
    externalId: `${method}-${n}`,
    loaded,
    startOdometer: method === "eld" ? 10_000 + n * 1000 : null,
    endOdometer: method === "eld" ? 10_000 + n * 1000 + miles : null,
    miles,
    startedAt: new Date(Date.UTC(2026, 7, n, 10)),
    endedAt: new Date(Date.UTC(2026, 7, n, 20)),
    syncBatchId: "b",
    syncedAt: NOW
  };
};
const fill = (vehicleId: string, state: string, gallons: string, day: number, over: Record<string, unknown> = {}) =>
  prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "wex", externalId: `p-${++seq}`, vehicleId, purchaseState: state, location: `Stop, ${state}`, product: "road_diesel", status: "settled", taxPaid: true, gallons, pricePerGallon: 3.5, amount: D(gallons).times(3.5).toDecimalPlaces(2), postedAt: new Date(Date.UTC(2026, 7, day, 12)), purchasedAt: new Date(Date.UTC(2026, 7, day, 14)), ...over } });

describe.skipIf(!run)("one IFTA quarter, every way it is read", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    t1 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 901" } })).id;
    t2 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 902" } })).id;
    t3 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 903" } })).id;
    await prisma.iftaMileage.createMany({
      data: [
        piece(t1, "eld", "TX", 1000.4), piece(t1, "eld", "OK", 500.3, false), piece(t1, "eld", "AR", 300.2),
        piece(t1, "routed", "TX", 1400), // set aside: t1 has ELD rows
        piece(t2, "eld", "TX", 800.1), piece(t2, "eld", "KY", 600.6), piece(t2, "eld", "IN", 400.5, false),
        piece(t3, "routed", "TX", 500), piece(t3, "routed", "AR", 100), piece(t3, "routed", "KY", 300.9)
      ]
    });
    await fill(t1, "TX", "300.4", 3);
    await fill(t2, "IN", "250.25", 5);
    await fill(t2, "KY", "50.5", 6);
    await fill(t3, "TX", "101", 7, { taxPaid: false });
    await fill(t3, "MO", "20", 8);
    await fill(t1, "TX", "40", 9, { product: "reefer_diesel" });
    await fill(t2, "TX", "80", 10, { status: "pending" });
    await commitIftaRates("Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nOklahoma,0.19,\nArkansas,0.285,\nKentucky,0.246,0.102\nIndiana,0.55,\nMissouri,0.195,", null, Q, "final", "q3.csv", NOW, W);
  });
  afterAll(wipe);

  test("the return adds up: lines to totals, trucks to the return", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    expect(r.blockers).toEqual([]);
    expect(sum(r.lines, (l) => l.miles).toFixed(1)).toBe(r.miles);
    expect(sum(r.lines, (l) => l.tax!).toFixed(2)).toBe(r.tax);
    expect(sum(r.lines, (l) => l.surcharge!).toFixed(2)).toBe(r.surcharge);
    expect(sum(r.lines, (l) => l.total!).toFixed(2)).toBe(r.total);
    expect(D(r.tax!).plus(r.surcharge!).toFixed(2)).toBe(r.total);
    // Trucks: miles by state and in all, gallons, tax-paid gallons by state (whole, as the lines are).
    expect(sum(r.trucks, (t) => t.miles).toFixed(1)).toBe(r.miles);
    expect(sum(r.trucks, (t) => t.gallons).toFixed(3)).toBe(r.gallons);
    expect(sum(r.trucks, (t) => t.bulkGallons).toFixed(3)).toBe(r.bulkGallons);
    for (const l of r.lines) {
      expect(sum(r.trucks.flatMap((t) => t.milesByState.filter((m) => m.jurisdiction === l.jurisdiction)), (m) => m.miles).toFixed(1), l.jurisdiction).toBe(l.miles);
      expect(roundGallons(sum(r.trucks.flatMap((t) => t.taxPaidByState.filter((m) => m.jurisdiction === l.jurisdiction)), (m) => m.gallons)).toFixed(0), l.jurisdiction).toBe(l.taxPaidGallons);
    }
    // The set-aside routed row is in no figure: t1 counts its ELD miles only.
    expect(r.trucks.find((t) => t.vehicleId === t1)).toMatchObject({ method: "eld", miles: "1800.9" });
    // The mileage summary /ifta also reads agrees.
    const q = (await iftaQuarterMiles(Q, W))!;
    expect(q.miles).toBe(r.miles);
    expect(q.states.map((s) => [s.state, s.miles])).toEqual(r.lines.filter((l) => D(l.miles).gt(0)).map((l) => [l.jurisdiction, l.miles]));
    expect(q.setAside).toBe(1);
  });

  test("the return CSV and the audit CSV say what the return says", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    const ret = rows((await buildExport("ifta", { quarter: Q }, NOW))!.csv).slice(1);
    expect(ret).toHaveLength(r.lines.length + 1);
    r.lines.forEach((l, i) => {
      expect(ret[i]![1]).toBe(l.jurisdiction);
      expect(D(ret[i]![3]!).equals(l.miles) && D(ret[i]![11]!).equals(l.total!)).toBe(true);
    });
    const all = ret[ret.length - 1]!;
    expect([D(all[3]!).equals(r.miles), D(all[8]!).equals(r.tax!), D(all[10]!).equals(r.surcharge!), D(all[11]!).equals(r.total!), D(all[12]!).equals(r.mpg!)]).toEqual([true, true, true, true, true]);

    const audit = rows((await buildExport("ifta-audit", { quarter: Q }, NOW))!.csv).slice(1);
    const miles = audit.filter((c) => c[1] === "miles");
    const fuel = audit.filter((c) => c[1] === "fuel");
    for (const l of r.lines) expect(sum(miles.filter((c) => c[5] === l.jurisdiction), (c) => c[12]!).toFixed(1), l.jurisdiction).toBe(l.miles);
    expect(sum(fuel.filter((c) => c[21] === "yes"), (c) => c[19]!).toFixed(3)).toBe(r.gallons);
    expect(sum(fuel.filter((c) => c[21] === "yes" && c[18] === "yes"), (c) => c[19]!).toFixed(3)).toBe(r.taxPaidGallons);
    expect(fuel).toHaveLength(7); // every receipt of the quarter, counted or not
  });

  test("each truck's audit adds up to its part of the return", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    for (const t of r.trucks) {
      const d = await iftaReturnDetail(Q, { vehicleId: t.vehicleId }, NOW, W);
      if (!d.ok) throw new Error(d.error);
      expect(sum(d.pieces, (p) => p.miles).toFixed(1), t.name ?? "").toBe(t.miles);
      expect(new Set(d.pieces.map((p) => p.method))).toEqual(new Set([t.method]));
      expect(sum(d.receipts.filter((f) => f.counted), (f) => f.gallons!).toFixed(3)).toBe(t.gallons);
      expect(d.mpg).toBe(r.mpg); // the fleet's, whatever truck is read
    }
  });

  test("filed, the snapshot is the return; it drifts only when a record changes, and the files follow the live return", async () => {
    expect(await fileIftaReturn(Q, {}, NOW, W)).toMatchObject({ ok: true });
    const live = await iftaReturn(Q, NOW, W);
    if (!live.ok) throw new Error(live.error);
    const { filed } = await iftaFiling(Q, W);
    expect(filed).toMatchObject({ miles: live.miles, gallons: live.gallons, taxPaidGallons: live.taxPaidGallons, bulkGallons: live.bulkGallons, mpg: live.mpg, tax: live.tax, surcharge: live.surcharge, total: live.total, trucks: live.trucks.length });
    expect(filed!.lines).toEqual(live.lines.map(({ name: _n, ...l }) => l));
    expect(returnDrift(filed!, live).changed).toBe(false);
    // The pending fill settles after filing: the return now differs from what was filed, by exactly that fill.
    await prisma.fuelTransaction.updateMany({ where: { workspaceId: W, status: "pending" }, data: { status: "settled" } });
    const after = await iftaReturn(Q, NOW, W);
    if (!after.ok) throw new Error(after.error);
    const d = returnDrift(filed!, after);
    expect(d.changed).toBe(true);
    expect(d.header.find((f) => f.field === "gallons")).toMatchObject({ filed: live.gallons, now: after.gallons, delta: "80" });
    expect(d.lines.find((l) => l.jurisdiction === "TX")!.fields.map((f) => f.field)).toContain("taxPaidGallons");
    // The files read the live return, not the snapshot.
    const all = rows((await buildExport("ifta", { quarter: Q }, NOW))!.csv).slice(1).pop()!;
    expect(D(all[11]!).equals(after.total!)).toBe(true);
    expect((await iftaFiling(Q, W)).filed!.total).toBe(live.total);
  });
});
