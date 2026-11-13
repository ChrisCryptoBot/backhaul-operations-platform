import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/import-csv";
import { commitIftaRates } from "@/server/partners/ifta-rates";
import { iftaReturn, iftaReturnDetail } from "@/server/partners/ifta-return";
import { buildExport } from "@/server/tl/exports";

/**
 * Wave 5 step 7: the return screen, the per-truck audit and both CSVs read one answer. The return CSV is the return's lines and totals; the audit CSV's mileage rows add up to each state's miles
 * and its counted fuel rows to the fleet's gallons; a truck's audit holds only its counted pieces (an ELD truck's set-aside routed rows are not there) and its own receipts.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-exports.integration.test.ts
 */
const W = "iexp-w";
vi.mock("@/server/tl/workspace", async (orig) => ({ ...(await orig<typeof import("@/server/tl/workspace")>()), currentWorkspaceId: () => W }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let truckA = "";
let truckB = "";
let load = "";

const piece = (vehicleId: string, method: "eld" | "routed", source: string, jurisdiction: string, miles: number, n: number, loadId: string | null = null) => ({
  workspaceId: W,
  vehicleId,
  quarter: Q,
  jurisdiction,
  source,
  method,
  externalId: `${method}-${jurisdiction}-${n}`,
  loaded: loadId != null,
  loadId,
  startOdometer: method === "eld" ? 1000 * n : null,
  endOdometer: method === "eld" ? 1000 * n + miles : null,
  miles,
  startedAt: new Date(`2026-08-0${n}T10:00:00Z`),
  endedAt: new Date(`2026-08-0${n}T20:00:00Z`),
  syncBatchId: "b",
  syncedAt: NOW
});

let seq = 0;
const fill = (vehicleId: string, state: string, gallons: number, at: string, over: Record<string, unknown> = {}) =>
  prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "wex", externalId: `rcpt-${++seq}`, vehicleId, purchaseState: state, location: `Stop ${seq}, ${state}`, product: "road_diesel", status: "settled", taxPaid: true, gallons, pricePerGallon: 3.5, amount: gallons * 3.5, postedAt: new Date(at), purchasedAt: new Date(at), ...over } });

const lines = (csv: string) => parseCsv(csv.slice(1)).filter((r) => r.some((c) => c !== ""));
const D = (v: string) => new Prisma.Decimal(v || "0");

describe.skipIf(!run)("the IFTA return, its audit and both CSVs agree", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    truckA = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 601" } })).id;
    truckB = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 602" } })).id;
    load = (await prisma.load.create({ data: { workspaceId: W, vehicleId: truckA, loadNumber: "L-601", status: "completed", completedAt: new Date("2026-08-01T20:00:00Z") } })).id;
    await prisma.iftaMileage.createMany({
      data: [
        piece(truckA, "eld", "motive", "TX", 700, 1, load),
        piece(truckA, "eld", "motive", "OK", 300, 2),
        piece(truckA, "routed", "promiles", "TX", 999, 3), // set aside: A has ELD rows
        piece(truckB, "routed", "promiles", "TX", 400, 4),
        piece(truckB, "routed", "promiles", "AR", 600, 5)
      ]
    });
    await fill(truckA, "TX", 120.5, "2026-08-01T12:00:00Z");
    await fill(truckB, "AR", 100, "2026-08-05T12:00:00Z");
    await fill(truckB, "TX", 80, "2026-08-06T12:00:00Z", { taxPaid: false });
    await fill(truckA, "TX", 25, "2026-08-02T12:00:00Z", { product: "reefer_diesel" });
    await commitIftaRates("Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nOklahoma,0.19,\nArkansas,0.285,", null, Q, "final", "q3.csv", NOW, W);
  });
  afterAll(wipe);

  test("the return CSV is the return: every line, then the totals, MPG and due date", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ dueDate: "2026-10-31", rateState: "final", miles: "2000.0", gallons: "300.500" });
    const csv = (await buildExport("ifta", { quarter: Q }, NOW))!;
    const [head, ...rows] = lines(csv.csv);
    expect(head).toEqual(["Quarter", "Jurisdiction", "Name", "Miles", "Taxable gallons", "Tax-paid gallons", "Net gallons", "Rate", "Tax", "Surcharge rate", "Surcharge", "Total", "Fleet MPG", "Due"]);
    // Figures are written as numbers: compare them as exact decimals. A credit is a plain negative number, never defused text.
    const eq = (cell: string, v: string | null) => (v == null ? cell === "" : D(cell).equals(v));
    expect(rows).toHaveLength(r.lines.length + 1);
    r.lines.forEach((l, i) => {
      const c = rows[i]!;
      expect(c[1]).toBe(l.jurisdiction);
      for (const [cell, v] of [[c[3], l.miles], [c[4], l.taxableGallons], [c[5], l.taxPaidGallons], [c[6], l.netGallons], [c[7], l.rate], [c[8], l.tax], [c[10], l.surcharge], [c[11], l.total], [c[12], r.mpg]] as const) expect(eq(cell!, v), `${l.jurisdiction} ${v}`).toBe(true);
      expect(c.some((x) => x.startsWith("'"))).toBe(false);
    });
    const all = rows[rows.length - 1]!;
    expect(all.slice(1, 3)).toEqual(["ALL", "All jurisdictions"]);
    expect([eq(all[3]!, r.miles), eq(all[8]!, r.tax), eq(all[10]!, r.surcharge), eq(all[11]!, r.total), all[13]]).toEqual([true, true, true, true, "2026-10-31"]);
    expect(r.lines.some((l) => l.total!.startsWith("-"))).toBe(true); // AR is a credit
  });

  test("the audit CSV reconciles: mileage rows add up to each state's miles, counted fuel rows to the fleet's gallons", async () => {
    const r = await iftaReturn(Q, NOW, W);
    if (!r.ok) throw new Error(r.error);
    const [, ...rows] = lines((await buildExport("ifta-audit", { quarter: Q }, NOW))!.csv);
    const miles = rows.filter((c) => c[1] === "miles");
    const fuel = rows.filter((c) => c[1] === "fuel");
    for (const l of r.lines) expect(miles.filter((c) => c[5] === l.jurisdiction).reduce((s, c) => s.plus(D(c[12]!)), D("0")).toFixed(1)).toBe(l.miles);
    expect(fuel.filter((c) => c[21] === "yes").reduce((s, c) => s.plus(D(c[19]!)), D("0")).toFixed(3)).toBe(r.gallons);
    expect(miles.some((c) => D(c[12]!).equals(999))).toBe(false); // the set-aside routed row is not counted, so not in the audit
    expect(miles.find((c) => c[7] === "L-601")).toMatchObject({ 4: "Motive", 5: "TX", 6: "loaded", 8: "1000", 9: "1700" });
    expect(fuel.map((c) => c[13]).sort()).toEqual(["rcpt-1", "rcpt-2", "rcpt-3", "rcpt-4"]);
    expect(fuel.find((c) => c[13] === "rcpt-4")).toMatchObject({ 16: "Reefer diesel", 21: "no" });
  });

  test("one truck's audit: its counted pieces and its own receipts, the fleet's MPG", async () => {
    const d = await iftaReturnDetail(Q, { vehicleId: truckB }, NOW, W);
    if (!d.ok) throw new Error(d.error);
    expect(d.pieces.map((p) => [p.jurisdiction, p.method, p.miles, p.startOdometer])).toEqual([
      ["TX", "routed", "400.0", null],
      ["AR", "routed", "600.0", null]
    ]);
    expect(d.receipts.map((f) => [f.externalId, f.taxPaid, f.counted])).toEqual([
      ["rcpt-2", true, true],
      ["rcpt-3", false, true]
    ]);
    const t = d.trucks.find((x) => x.vehicleId === truckB)!;
    expect(t.miles).toBe(d.pieces.reduce((s, p) => s.plus(p.miles), D("0")).toFixed(1));
    expect(d.mpg).toBe("6.66"); // 2000 / 300.5, the fleet's
    const [, ...rows] = lines((await buildExport("ifta-audit", { quarter: Q, truck: truckB }, NOW))!.csv);
    expect(rows.every((c) => c[2] === "Unit 602")).toBe(true);
    expect(rows).toHaveLength(4);
  });

  test("a quarter that is not one gives no file", async () => {
    expect(await buildExport("ifta", { quarter: "nonsense" }, NOW)).toBeNull();
    expect(await buildExport("ifta-audit", { quarter: "2026-Q9" }, NOW)).toBeNull();
  });
});
