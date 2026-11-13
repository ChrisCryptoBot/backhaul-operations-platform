import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { commitFuelImport, listFuelImports, previewFuelImport, removeFuelImport } from "@/server/partners/fuel-import";
import { listFuel } from "@/server/partners/fuel-store";
import { eligibleFuel } from "@/server/tl/settlement";

/**
 * Wave 5 step 2: fuel purchases from a CSV. Read like a card's, kept once, tied to truck and load, one audit event per file, and a file taken away whole unless a purchase from it is on a
 * driver statement. A workspace of its own:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/fuel-import.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fimp-w";
const OTHER = "fimp-other";
const NOW = new Date();
const dayAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

async function wipe() {
  for (const id of [W, OTHER]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: id } });
    await prisma.settlement.deleteMany({ where: { workspaceId: id } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: id } } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

const FILE = [
  "Transaction ID,Date,Time,Unit,Card,Merchant,State,Product,Gallons,PPU,Discount per gallon,Net Amount,Status,Bulk",
  `T-1,${dayAgo(3)},08:15,Unit 7,,Pilot Flying J,Texas,ULSD,120,3.90,0.25,438.00,Posted,`,
  `T-2,${dayAgo(3)},08:20,Unit 7,,Pilot Flying J,TX,Reefer,30,3.90,0.25,109.50,Posted,`,
  `T-3,${dayAgo(2)},,,FLEET-77,"Love's, Tulsa, OK",,DEF,5,4.00,,20.00,,`,
  `T-4,${dayAgo(1)},,Unit 7,,Yard tank,OK,Diesel,90,3.10,,279.00,Pending,yes`,
  `T-5,${dayAgo(1)},,Unit 404,,Somewhere,,Unleaded,15,3.20,,48.00,,`,
  `T-6,not a day,,Unit 7,,Pilot,TX,Diesel,10,3.90,,39.00,,`,
  `T-1,${dayAgo(3)},08:15,Unit 7,,Pilot Flying J,Texas,ULSD,120,3.90,0.25,438.00,Posted,`
].join("\n");

describe.skipIf(!run)("fuel purchases from a CSV file", () => {
  let truck = "";
  let other = "";
  let loadId = "";
  let driverId = "";
  let batchId = "";
  const row = (externalId: string) => prisma.fuelTransaction.findFirstOrThrow({ where: { workspaceId: W, provider: "csv", externalId } });

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "FIMP desk", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "FIMP other", plan: "enterprise" } });
    truck = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 7", type: "reefer" } })).id;
    other = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 8", type: "dry_van", costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.8, fuelCardProvider: "wex", fuelCardAccountId: "FLEET-77" } } } })).id;
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "File Driver", assignedVehicleId: truck } })).id;
    loadId = (
      await prisma.load.create({
        data: {
          workspaceId: W,
          vehicleId: truck,
          loadNumber: "FI-1",
          status: "completed",
          completedAt: new Date(`${dayAgo(2)}T18:00:00Z`),
          quotedRevenue: 2000,
          loadedMiles: 700,
          stops: { create: [{ stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(`${dayAgo(3)}T13:00:00Z`) }, { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(`${dayAgo(2)}T15:00:00Z`) }] },
          assignment: { create: { driverId, payKind: "cpm", payRate: 1, status: "completed" } }
        }
      })
    ).id;
  });
  afterAll(wipe);

  test("the preview reads every row and writes nothing", async () => {
    const p = await previewFuelImport(FILE, null, NOW, W);
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ total: 7, ready: 5, duplicates: 1, problemCount: 1, missing: [] });
    expect(p.problems[0]).toMatchObject({ line: 7 });
    expect(p.warnings).toEqual({ noTruck: 1, noState: 1, noProduct: 0 });
    expect(p.summary).toMatchObject({ purchases: 4, notCounted: 1, charged: 615.5 });
    expect(p.sample[0]).toMatchObject({ truck: "Unit 7", state: "TX", product: "road_diesel" });
    expect(await prisma.fuelTransaction.count({ where: { workspaceId: W } })).toBe(0);
  });

  test("the import keeps each purchase once, read like a card's, tied to its truck and load, with one audit event", async () => {
    const out = await commitFuelImport(FILE, null, "wex-export.csv", NOW, W);
    if (!out.ok) throw new Error(out.error);
    batchId = out.batchId;
    expect(out).toMatchObject({ created: 5, duplicates: 1, skipped: 1, updated: 0 });

    const t1 = await row("txn:T-1");
    expect(t1).toMatchObject({ vehicleId: truck, loadId, purchaseState: "TX", product: "road_diesel", status: "settled", taxPaid: true, importBatchId: batchId, location: "Pilot Flying J, TX" });
    expect(Number(t1.discount)).toBe(30);
    expect(t1.purchasedAt).not.toBeNull();
    expect(await row("txn:T-2")).toMatchObject({ product: "reefer_diesel" });
    expect(await row("txn:T-3")).toMatchObject({ vehicleId: other, purchaseState: "OK", purchaseCity: "Tulsa", product: "def" }); // by the card account
    expect(await row("txn:T-4")).toMatchObject({ status: "pending", taxPaid: false });
    expect(await row("txn:T-5")).toMatchObject({ vehicleId: null, purchaseState: null, product: "gasoline" });

    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "fuel_csv_imported" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityId).toBe(batchId);

    // The screen reads them like any purchase: settled ones counted, named as a file.
    const list = await listFuel({ days: 30 }, NOW, W);
    expect(list.totals).toMatchObject({ purchases: 4, notCounted: 1, charged: 615.5 });
    expect(list.rows[0]!.providerName).toBe("CSV file");
    // And a driver statement is offered the settled ones on the driver's truck or load.
    expect((await eligibleFuel(driverId, dayAgo(10), dayAgo(0), W)).map((f) => f.amount).sort((a, b) => a - b)).toEqual([109.5, 438]);
  });

  test("the same file again adds nothing; a later file takes a status the source moved on, and only that", async () => {
    expect(await commitFuelImport(FILE, null, "wex-export.csv", NOW, W)).toEqual({ ok: false, error: "Every purchase in that file is already on the desk." });
    const later = ["Transaction ID,Date,Unit,State,Product,Gallons,Net Amount,Status", `T-4,${dayAgo(1)},Unit 7,OK,Diesel,90,1.00,Posted`, `T-1,${dayAgo(3)},Unit 7,TX,Diesel,120,438.00,Pending`].join("\n");
    const out = await commitFuelImport(later, null, "wex-later.csv", NOW, W);
    expect(out).toMatchObject({ ok: true, created: 0, updated: 1, duplicates: 2 });
    expect(await row("txn:T-4")).toMatchObject({ status: "settled" });
    expect(Number((await row("txn:T-4")).amount)).toBe(279); // the figures stay the first file's
    expect(await row("txn:T-1")).toMatchObject({ status: "settled" }); // never back to pending
  });

  test("a file is not removed while a purchase from it is deducted on a driver statement; once that is undone it goes, whole", async () => {
    const st = await prisma.settlement.create({ data: { workspaceId: W, driverId, number: "ST-FI-1", status: "final", periodStart: new Date(`${dayAgo(10)}T00:00:00Z`), periodEnd: new Date(`${dayAgo(0)}T00:00:00Z`), total: 100, finalizedAt: NOW } });
    await prisma.fuelTransaction.update({ where: { id: (await row("txn:T-1")).id }, data: { settlementId: st.id } });

    const listed = (await listFuelImports(10, W)).find((b) => b.batchId === batchId)!;
    expect(listed).toMatchObject({ rows: 5, deducted: 1, removed: false });
    const refused = await removeFuelImport(batchId, NOW, W);
    expect(refused).toEqual({ ok: false, error: "1 purchase from this file is deducted on driver statement ST-FI-1. Void that statement first, or keep the import." });
    expect(await prisma.fuelTransaction.count({ where: { workspaceId: W, importBatchId: batchId } })).toBe(5);

    // Another fleet cannot touch it.
    expect(await removeFuelImport(batchId, NOW, OTHER)).toEqual({ ok: false, error: "That import is not on this desk." });

    // Voiding the statement gives the purchase back; then the whole file goes.
    await prisma.fuelTransaction.updateMany({ where: { settlementId: st.id }, data: { settlementId: null } });
    expect(await removeFuelImport(batchId, NOW, W)).toEqual({ ok: true, removed: 5 });
    expect(await prisma.fuelTransaction.count({ where: { workspaceId: W } })).toBe(0);
    expect((await listFuelImports(10, W)).find((b) => b.batchId === batchId)).toMatchObject({ rows: 0, removed: true });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "fuel_csv_removed", entityId: batchId } })).toBe(1);
    expect(await removeFuelImport(batchId, NOW, W)).toEqual({ ok: false, error: "Nothing of that import is left on the desk." });
  });
});
