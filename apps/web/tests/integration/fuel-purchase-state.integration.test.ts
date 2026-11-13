import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { journalFile } from "@/server/partners/accounting";
import { listFuel, storePurchases } from "@/server/partners/fuel-store";
import { buildExport } from "@/server/tl/exports";
import { eligibleFuel, finalizeSettlement, getSettlement, saveDraft, startSettlement } from "@/server/tl/settlement";

/**
 * Wave 5 step 1: a purchase keeps the state it was bought in, what was pumped and where it stands, and only a settled one is counted or offered. A workspace of its own, so the figures are exact:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/fuel-purchase-state.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fps-w";
const NOW = new Date();
const dayAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("fuel purchases: state, product and status", () => {
  let truckId = "";
  let driverId = "";
  const P = (id: string, on: string, over: Record<string, unknown> = {}) => ({ id, on, gallons: 100, amount: 375, pricePerGallon: 4, discountPerGallon: 0.25, discount: 25, location: "Pilot, Dallas, TX", ...over });
  const row = (externalId: string) => prisma.fuelTransaction.findFirstOrThrow({ where: { workspaceId: W, externalId } });

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "FPS desk", plan: "enterprise" } });
    truckId = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 9", type: "reefer" } })).id;
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "State Driver", assignedVehicleId: truckId } })).id;
    await storePurchases(
      "wex",
      [
        P("road", dayAgo(3), { state: "TX", city: "Dallas", product: "road_diesel", purchasedAt: `${dayAgo(3)}T14:05:00Z` }),
        P("reefer", dayAgo(3), { gallons: 40, amount: 150, discount: 10, product: "reefer_diesel" }),
        P("def", dayAgo(3), { gallons: 4, amount: 16.8, discount: 0, pricePerGallon: 4.2, discountPerGallon: 0, product: "def" }),
        P("pending", dayAgo(1), { status: "pending", amount: 300 }),
        P("declined", dayAgo(2), { status: "declined", amount: 999 }),
        P("void", dayAgo(2), { status: "void", amount: 888 }),
        P("noplace", dayAgo(2), { location: "Somewhere", amount: 100, gallons: 25, discount: 0 })
      ],
      { workspaceId: W, vehicleId: truckId }
    );
  });
  afterAll(wipe);

  test("each purchase keeps its state (the source's, else the end of its place line), city, product, status and moment", async () => {
    expect(await row("road")).toMatchObject({ purchaseState: "TX", purchaseCity: "Dallas", product: "road_diesel", status: "settled", taxPaid: true });
    expect((await row("road")).purchasedAt?.toISOString()).toBe(`${dayAgo(3)}T14:05:00.000Z`);
    expect(await row("reefer")).toMatchObject({ purchaseState: "TX", purchaseCity: "Dallas", product: "reefer_diesel" });
    expect(Number((await row("def")).gallons)).toBe(4);
    expect(await row("noplace")).toMatchObject({ purchaseState: null, purchaseCity: null, product: "unknown" });
    expect(await row("pending")).toMatchObject({ status: "pending" });
  });

  test("totals count settled purchases only; gallons and the price a gallon are over fuel, DEF kept apart", async () => {
    const { rows, totals } = await listFuel({ days: 30 }, NOW, W);
    expect(rows).toHaveLength(7); // every status is listed
    // Settled: road 375, reefer 150, DEF 16.8, no-place 100.
    expect(totals).toMatchObject({ purchases: 4, notCounted: 3, charged: 641.8, discount: 35 });
    expect(totals.gallons).toBe(165); // 100 road + 40 reefer + 25 unknown, not DEF's 4
    expect(totals.byProduct).toEqual({ road_diesel: 100, reefer_diesel: 40, def: 4, unknown: 25 });
    expect(totals.netPerGallon).toBe(3.788); // (375 + 150 + 100) / 165
    expect(rows.find((r) => r.status === "declined")).toMatchObject({ amount: 999, product: "unknown" });
  });

  test("a statement is offered only settled purchases", async () => {
    const offered = await eligibleFuel(driverId, dayAgo(10), dayAgo(0), W);
    expect(offered.map((f) => f.amount).sort((a, b) => a - b)).toEqual([16.8, 100, 150, 375]);
  });

  test("read again: pending settles with the settled figures, a settled one is only ever reversed, missing details fill in and nothing is overwritten", async () => {
    expect(await storePurchases("wex", [P("pending", dayAgo(1), { status: "settled", amount: 310.25 })], { workspaceId: W, vehicleId: truckId })).toBe(0);
    expect(await row("pending")).toMatchObject({ status: "settled" });
    expect(Number((await row("pending")).amount)).toBe(310.25);

    // A settled purchase is never sent back to pending or declined, and its figures stay.
    await storePurchases("wex", [P("road", dayAgo(3), { status: "pending", amount: 1 }), P("reefer", dayAgo(3), { status: "declined" })], { workspaceId: W, vehicleId: truckId });
    expect(await row("road")).toMatchObject({ status: "settled" });
    expect(Number((await row("road")).amount)).toBe(375);
    expect(await row("reefer")).toMatchObject({ status: "settled" });
    // Reversed after it settled: void, and no longer counted or offered.
    await storePurchases("wex", [P("reefer", dayAgo(3), { status: "void" })], { workspaceId: W, vehicleId: truckId });
    expect(await row("reefer")).toMatchObject({ status: "void" });
    expect((await eligibleFuel(driverId, dayAgo(10), dayAgo(0), W)).some((f) => f.amount === 150)).toBe(false);
    // Declined and void are final.
    await storePurchases("wex", [P("declined", dayAgo(2), { status: "settled" })], { workspaceId: W, vehicleId: truckId });
    expect(await row("declined")).toMatchObject({ status: "declined" });

    // Missing details fill in; a known product is not replaced.
    await storePurchases("wex", [P("noplace", dayAgo(2), { state: "Oklahoma", city: "Tulsa", product: "road_diesel" }), P("def", dayAgo(3), { product: "road_diesel" })], { workspaceId: W, vehicleId: truckId });
    expect(await row("noplace")).toMatchObject({ purchaseState: "OK", purchaseCity: "Tulsa", product: "road_diesel" });
    expect(await row("def")).toMatchObject({ product: "def" });
  });

  test("a purchase the card voids after it was picked on a draft does not come off pay at finalize", async () => {
    await prisma.load.create({ data: { workspaceId: W, vehicleId: truckId, loadNumber: "FPS-1", status: "completed", completedAt: new Date(`${dayAgo(2)}T15:00:00Z`), quotedRevenue: 1000, loadedMiles: 500, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", assignment: { create: { driverId, payKind: "cpm", payRate: 1, status: "completed" } } } });
    const started = await startSettlement({ driverId, start: dayAgo(10), end: dayAgo(0) }, NOW, W);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const road = (await row("road")).id;
    const pending = (await row("pending")).id; // settled earlier in this file
    expect(await saveDraft(started.id, { hours: {}, adjustments: [], fuel: [road, pending] }, W)).toMatchObject({ ok: true });
    // The card reverses one before the statement is finalized.
    await storePurchases("wex", [P("road", dayAgo(3), { status: "void" })], { workspaceId: W, vehicleId: truckId });
    const view = (await getSettlement(started.id, W))!;
    expect(view.statement.fuel.map((f) => f.id)).toEqual([pending]);
    expect(await finalizeSettlement(started.id, { hours: {}, adjustments: [], fuel: [road, pending] }, NOW, W, view.statement.total)).toEqual({ ok: true, id: started.id });
    expect((await row("road")).settlementId).toBeNull();
    expect((await row("pending")).settlementId).toBe(started.id);
  });

  test("the books take settled purchases only", async () => {
    const j = await journalFile({}, W);
    if (!j.ok) throw new Error(`${j.error} ${j.problems.join("; ")} ${j.unmapped.join(", ")}`);
    expect(j.csv).not.toContain("888.00");
    expect(j.csv).not.toContain("999.00");
    expect(j.csv).toContain("310.25");
  });

  test("the Fuel file has the state, product and status columns", async () => {
    const csv = await buildExport("fuel", { days: "30" }, NOW);
    expect(csv!.csv.slice(1).split(/\r?\n/)[0]).toBe("Date,Truck,Where,State,Product,Status,Card company,Gallons,Price a gallon,Discount a gallon,Discount,Charged,Load,Driver statement,Open flags");
  });
});
