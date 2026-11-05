import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { storePurchases } from "@/server/partners/fuel-store";
import { listFuel } from "@/server/partners/fuel-store";
import { sendToPayroll } from "@/server/partners/payroll";
import { buildExport } from "@/server/tl/exports";
import { eligibleFuel, finalizeSettlement, getSettlement, listSettlements, saveDraft, startSettlement, voidSettlement } from "@/server/tl/settlement";

/**
 * Fuel card purchases deducted from a driver's pay: offered on a draft, picked by a person, frozen when the statement is finalized, taken once, given back when the statement is voided. A
 * workspace of its own, so the figures are exact:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/settlement-fuel.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sf-w";
const OTHER = "sf-other";
const noon = (d: string) => `${d}T12:00:00Z`;

async function wipe() {
  for (const id of [W, OTHER]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.settlement.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

describe.skipIf(!run)("fuel deducted on driver statements", () => {
  let driverId = "";
  let otherDriverId = "";
  let truckId = "";
  let otherTruckId = "";
  let loadId = "";
  const P = (on: string, amount: number, id: string, over: Record<string, unknown> = {}) => ({ on, gallons: 100, amount, id, location: "Pilot, Dallas, TX", pricePerGallon: 4, discount: 25, discountPerGallon: 0.25, ...over });

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "SF desk", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "SF other", plan: "enterprise" } });
    truckId = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 1", type: "dry_van" } })).id;
    otherTruckId = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 2", type: "dry_van" } })).id;
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "Fuel Driver", assignedVehicleId: truckId } })).id;
    otherDriverId = (await prisma.driver.create({ data: { workspaceId: W, name: "Other Driver", assignedVehicleId: otherTruckId } })).id;
    loadId = (await prisma.load.create({ data: { workspaceId: W, vehicleId: truckId, loadNumber: "SF-1", status: "completed", completedAt: new Date(noon("2026-11-05")), quotedRevenue: 1500, loadedMiles: 800, originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } })).id;
    // Purchases: three on the driver's truck in the week, one the day before it, one on the other driver's truck, and one in another fleet.
    await storePurchases("wex", [P("2026-11-02", 300, "in-1"), P("2026-11-03", 200.5, "in-2"), P("2026-11-06", 99.5, "in-3"), P("2026-10-31", 80, "before")], { workspaceId: W, vehicleId: truckId });
    await storePurchases("wex", [P("2026-11-03", 150, "other-truck")], { workspaceId: W, vehicleId: otherTruckId });
    await storePurchases("wex", [P("2026-11-03", 70, "foreign")], { workspaceId: OTHER, vehicleId: null });
  });
  afterAll(wipe);

  const idOf = async (externalId: string) => (await prisma.fuelTransaction.findFirstOrThrow({ where: { externalId } })).id;
  let statementId = "";

  test("a draft is offered the purchases on the driver's truck in the period, and nobody else's", async () => {
    const start = await startSettlement({ driverId, start: "2026-11-01", end: "2026-11-07" }, new Date(), W);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    statementId = start.id;
    const view = (await getSettlement(statementId, W))!;
    expect(view.status).toBe("draft");
    expect(view.fuelOptions.map((f) => f.amount).sort((a, b) => a - b)).toEqual([99.5, 200.5, 300]);
    expect(view.fuelPicked).toEqual([]);
    // None are picked until a person picks them: the total is the pay for the load alone.
    expect(view.statement).toMatchObject({ loadsTotal: 400, fuelTotal: 0, total: 400, fuel: [] });
    // A purchase on the driver's own load counts even when it was not on their truck.
    expect(await eligibleFuel(driverId, "2026-11-01", "2026-11-07", W)).toHaveLength(3);
    expect(await eligibleFuel(otherDriverId, "2026-11-01", "2026-11-07", W)).toHaveLength(1);
  });

  test("picking keeps the picks, ignores a purchase that is not on offer, and the draft total moves with them", async () => {
    const a = await idOf("in-1");
    const b = await idOf("in-2");
    const stranger = await idOf("other-truck");
    expect(await saveDraft(statementId, { hours: {}, adjustments: [], fuel: [a, b, stranger] }, W)).toMatchObject({ ok: true });
    const view = (await getSettlement(statementId, W))!;
    expect(view.fuelPicked.sort()).toEqual([a, b].sort());
    expect(view.statement).toMatchObject({ fuelTotal: 500.5, total: -100.5 }); // 400 - 500.5
    expect(view.statement.cautions.join(" ")).toContain("more than the pay");
    // The list shows the same net.
    const row = (await listSettlements(W, { status: "draft" })).find((r) => r.id === statementId)!;
    expect(row).toMatchObject({ fuelTotal: 500.5, total: -100.5 });
    // Pick just one.
    await saveDraft(statementId, { hours: {}, adjustments: [], fuel: [a] }, W);
    expect((await getSettlement(statementId, W))!.statement).toMatchObject({ fuelTotal: 300, total: 100 });
  });

  test("finalizing freezes the ledger and the net, takes each purchase once, and refuses a total the person did not see", async () => {
    const a = await idOf("in-1");
    const b = await idOf("in-2");
    await saveDraft(statementId, { hours: {}, adjustments: [{ label: "Bonus", amount: "25" }], fuel: [a, b] }, W);
    // The person was looking at a different total: refused with the new figure.
    expect(await finalizeSettlement(statementId, { hours: {}, adjustments: [{ label: "Bonus", amount: "25" }], fuel: [a, b] }, new Date(), W, 999)).toMatchObject({ ok: false, error: expect.stringContaining("now comes to") });
    expect(await finalizeSettlement(statementId, { hours: {}, adjustments: [{ label: "Bonus", amount: "25" }], fuel: [a, b] }, new Date(), W, -75.5)).toEqual({ ok: true, id: statementId });
    const s = await prisma.settlement.findUniqueOrThrow({ where: { id: statementId } });
    expect(Number(s.total)).toBe(-75.5); // 400 - 500.5 + 25
    expect((s.fuel as Array<{ amount: number }>).map((f) => f.amount).sort((x, y) => x - y)).toEqual([200.5, 300]);
    const taken = await prisma.fuelTransaction.findMany({ where: { settlementId: statementId } });
    expect(taken.map((t) => t.externalId).sort()).toEqual(["in-1", "in-2"]);
    // Frozen: a change to the purchase afterwards does not change the statement.
    await prisma.fuelTransaction.update({ where: { id: a }, data: { amount: 1 } });
    const view = (await getSettlement(statementId, W))!;
    expect(view.status).toBe("final");
    expect(view.statement).toMatchObject({ loadsTotal: 400, fuelTotal: 500.5, adjustmentsTotal: 25, total: -75.5 });
    expect(view.statement.fuel).toHaveLength(2);
    await prisma.fuelTransaction.update({ where: { id: a }, data: { amount: 300 } });
    // A purchase already deducted is not offered again.
    expect((await eligibleFuel(driverId, "2026-11-01", "2026-11-07", W)).map((f) => f.amount)).toEqual([99.5]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "statement_finalized" } });
    expect(JSON.stringify(audit.after)).toContain("Fuel card");
  });

  test("the Fuel list names the statement a purchase was deducted on, and the files carry it", async () => {
    const list = await listFuel({ days: 400 }, new Date("2026-11-30T00:00:00Z"), W);
    const deducted = list.rows.filter((r) => r.deducted);
    expect(deducted.map((r) => r.amount).sort((x, y) => x - y)).toEqual([200.5, 300]);
    expect(deducted.every((r) => r.statementId === statementId)).toBe(true);
    const settlements = await buildExport("settlements", { status: "final" }, new Date());
    expect(settlements!.csv).toContain("Fuel card deducted");
    // (The files are built for the signed-in fleet, so the lines themselves are pinned in the source: a purchase is a "Fuel card" row, negative, as on the statement.)
    const exports = fs.readFileSync(path.join(__dirname, "..", "..", "src", "server", "tl", "exports.ts"), "utf8");
    expect(exports).toContain('"Fuel card", f.loadNumber');
    expect(exports).toContain("two(-f.amount)");
  });

  test("a statement that came to a negative amount is not sent to payroll", async () => {
    // Fuel was more than the pay: the statement is money the driver owes, not something to pay out.
    expect(await sendToPayroll([statementId], new Date(), W)).toMatchObject({ ok: false });
  });

  test("voiding gives every purchase back, and they can be deducted on a new statement", async () => {
    expect(await voidSettlement(statementId, "Wrong period", new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.fuelTransaction.count({ where: { settlementId: statementId } })).toBe(0);
    expect((await eligibleFuel(driverId, "2026-11-01", "2026-11-07", W)).map((f) => f.amount).sort((x, y) => x - y)).toEqual([99.5, 200.5, 300]);
    // The Fuel list no longer says deducted for a voided statement.
    const list = await listFuel({ days: 400 }, new Date("2026-11-30T00:00:00Z"), W);
    expect(list.rows.some((r) => r.deducted)).toBe(false);
    // A new statement can pick them and finalize.
    const again = await startSettlement({ driverId, start: "2026-11-01", end: "2026-11-07" }, new Date(), W);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const all = (await getSettlement(again.id, W))!.fuelOptions.map((f) => f.id);
    expect(all).toHaveLength(3);
    await saveDraft(again.id, { hours: {}, adjustments: [], fuel: [all[0]!] }, W);
    const view = (await getSettlement(again.id, W))!;
    expect(view.statement.fuel).toHaveLength(1);
    expect(await finalizeSettlement(again.id, { hours: {}, adjustments: [], fuel: [all[0]!] }, new Date(), W, view.statement.total)).toEqual({ ok: true, id: again.id });
    expect(await prisma.fuelTransaction.count({ where: { settlementId: again.id } })).toBe(1);
  });

  test("one fleet's purchases are never offered to another's statement", async () => {
    expect((await eligibleFuel(driverId, "2026-11-01", "2026-11-07", OTHER)).length).toBe(0);
  });
});
