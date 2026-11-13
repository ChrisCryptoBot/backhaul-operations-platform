import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearFuelFlag } from "@/server/partners/fuel-flags";
import { commitIftaRates } from "@/server/partners/ifta-rates";
import { fileIftaReturn } from "@/server/partners/ifta-filing";
import { clearHealthCache, getDataHealth } from "@/server/tl/data-health";

/**
 * Wave 5 step 9: Data health reads fuel and fuel tax. Open flags, a purchase with no state, on no truck, or with no product, by terminal; the last finished quarter's return blocked, then filed,
 * then changed since filed. A workspace of its own:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/data-health-fuel.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "dhfuel-w";
const NOW = new Date("2026-11-13T15:00:00Z"); // the last finished quarter is 2026-Q3
const Q = "2026-Q3";

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let dallas = "";
let memphis = "";
let overfill = "";
let seq = 0;
const fill = (vehicleId: string | null, state: string | null, gallons: number, at: string, over: Record<string, unknown> = {}) =>
  prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "csv", externalId: `f-${++seq}`, vehicleId, purchaseState: state, product: "road_diesel", status: "settled", taxPaid: true, gallons, pricePerGallon: 3.5, amount: gallons * 3.5, postedAt: new Date(at), purchasedAt: new Date(at), ...over } });
const health = async (terminals: string[] | null = null) => {
  clearHealthCache();
  return (await getDataHealth({ period: "all", terminals }, NOW, W)).fuelTax;
};

describe.skipIf(!run)("Data health: fuel and fuel tax", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    dallas = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 801", terminal: "Dallas", tankCapacityGallons: 150 } })).id;
    memphis = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 802", terminal: "Memphis" } })).id;
    await prisma.iftaMileage.createMany({
      data: [
        { workspaceId: W, vehicleId: dallas, quarter: Q, jurisdiction: "TX", source: "promiles", method: "routed", externalId: "r-1", loaded: true, miles: 1300, startedAt: new Date("2026-08-01T10:00:00Z"), endedAt: new Date("2026-08-01T20:00:00Z"), syncBatchId: "b", syncedAt: NOW },
        { workspaceId: W, vehicleId: memphis, quarter: Q, jurisdiction: "TN", source: "promiles", method: "routed", externalId: "r-2", loaded: true, miles: 700, startedAt: new Date("2026-08-02T10:00:00Z"), endedAt: new Date("2026-08-02T20:00:00Z"), syncBatchId: "b", syncedAt: NOW }
      ]
    });
    overfill = (await fill(dallas, "TX", 190, "2026-08-05T12:00:00Z")).id; // over Dallas's 150-gallon tanks: flagged
    await fill(memphis, "TN", 110, "2026-08-06T12:00:00Z");
    await fill(memphis, null, 20, "2026-10-20T12:00:00Z"); // no state (Q4, in the window)
    await fill(null, "TX", 30, "2026-10-21T12:00:00Z"); // no truck
    await fill(dallas, "TX", 15, "2026-10-22T12:00:00Z", { product: "unknown" });
    await fill(dallas, "TX", 10, "2026-10-23T12:00:00Z", { status: "declined" });
  });
  afterAll(wipe);

  test("the whole fleet: flags, a missing state, truck and product, and the quarter blocked", async () => {
    const f = await health();
    // The fill with no state and the one on no truck carry their own flags too (step 3), so three purchases are flagged.
    expect(f).toMatchObject({ purchases: 5, flaggedPurchases: 3, noState: 1, noTruck: 1, unknownProduct: 1 });
    expect(f.quarter).toMatchObject({ quarter: Q, dueDate: "2026-10-31", filed: false });
    expect(f.quarter!.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["missing_rate", "open_flags"]));
    expect(f.issues.map((i) => i.key)).toEqual(["open_flags", "fuel_no_state", "fuel_no_truck", "fuel_unknown_product", "ifta_blocked"]);
  });

  test("by terminal: a purchase counts by its truck's terminal; one on no truck only fleet-wide", async () => {
    expect(await health(["Memphis"])).toMatchObject({ purchases: 2, flaggedPurchases: 1, noState: 1, noTruck: 0, unknownProduct: 0 });
    expect(await health(["Dallas"])).toMatchObject({ purchases: 2, flaggedPurchases: 1, noState: 0, noTruck: 0, unknownProduct: 1 });
  });

  test("filed, the quarter stops being a gap; a late receipt makes it changed since filed", async () => {
    expect(await clearFuelFlag(overfill, "over_capacity", "Saddle tanks fitted", NOW, W)).toEqual({ ok: true });
    expect(await commitIftaRates("Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nTennessee,0.27,", null, Q, "final", "q3.csv", NOW, W)).toMatchObject({ ok: true });
    expect(await fileIftaReturn(Q, {}, NOW, W)).toMatchObject({ ok: true });
    let f = await health();
    expect(f.quarter).toMatchObject({ filed: true, changedSinceFiled: false });
    expect(f.issues.map((i) => i.key)).not.toContain("ifta_blocked");
    await fill(memphis, "TN", 40, "2026-09-28T12:00:00Z");
    f = await health();
    expect(f.quarter).toMatchObject({ filed: true, changedSinceFiled: true });
    expect(f.issues.find((i) => i.key === "ifta_changed")).toMatchObject({ href: `/ifta?quarter=${Q}` });
  });
});
