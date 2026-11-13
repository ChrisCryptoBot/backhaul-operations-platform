import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { returnDrift } from "@/lib/ifta-return";
import { removeFuelImport } from "@/server/partners/fuel-import";
import { calculateIfta } from "@/server/partners/ifta";
import { fileIftaReturn, iftaFiling, reopenIftaReturn } from "@/server/partners/ifta-filing";
import { syncIftaMileage } from "@/server/partners/ifta-mileage";
import { clearIftaRates, commitIftaRates, loadSampleIftaRates } from "@/server/partners/ifta-rates";
import { iftaReturn } from "@/server/partners/ifta-return";

/**
 * Wave 5 step 8: filing a quarter freezes its return and locks the quarter. Refused while anything blocks it or on sample rates; provisional rates only with a confirmation; one filed return per
 * quarter (also under a race); the snapshot can never be edited (a database trigger); every writer of the quarter's rates, miles and fuel files refuses; a late receipt shows as changed since
 * filed; reopening with a reason frees the quarter and the next filing is an amendment. All audited.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-filing.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ifile-w";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";
const RATES = "Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nOklahoma,0.19,\nArkansas,0.285,";
const BATCH_IN = "a1b2c3d4e5f60718";
const BATCH_OUT = "0f1e2d3c4b5a6978";

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let truck = "";
let seq = 0;
const fill = (state: string, gallons: number, at: string, over: Record<string, unknown> = {}) =>
  prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "csv", externalId: `f-${++seq}`, vehicleId: truck, purchaseState: state, product: "road_diesel", status: "settled", taxPaid: true, gallons, pricePerGallon: 3.5, amount: gallons * 3.5, postedAt: new Date(at), purchasedAt: new Date(at), ...over } });
const audits = (action: string) => prisma.auditEvent.count({ where: { workspaceId: W, action } });

describe.skipIf(!run)("filing an IFTA return", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise" } });
    truck = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 701" } })).id;
    const piece = (jurisdiction: string, miles: number, n: number) => ({ workspaceId: W, vehicleId: truck, quarter: Q, jurisdiction, source: "promiles", method: "routed", externalId: `r-${n}`, loaded: true, miles, startedAt: new Date(`2026-08-0${n}T10:00:00Z`), endedAt: new Date(`2026-08-0${n}T20:00:00Z`), syncBatchId: "b", syncedAt: NOW });
    await prisma.iftaMileage.createMany({ data: [piece("TX", 1600, 1), piece("OK", 500, 2), piece("AR", 400, 3)] });
    await fill("TX", 200, "2026-07-15T14:00:00Z");
    await fill("AR", 150, "2026-08-10T14:00:00Z");
    await fill("TX", 50, "2026-09-01T12:00:00Z", { taxPaid: false, importBatchId: BATCH_IN });
    // A file with a purchase in Q4 only: removable whatever happens to Q3.
    await fill("TX", 40, "2026-10-20T12:00:00Z", { importBatchId: BATCH_OUT });
    for (const id of [BATCH_IN, BATCH_OUT]) await prisma.auditEvent.create({ data: { workspaceId: W, entity: "fleet", entityId: id, action: "fuel_csv_imported", summary: "test file" } });
  });
  afterAll(wipe);

  test("refused while blocked: no rates, then sample rates", async () => {
    expect(await fileIftaReturn("2026Q3", {}, NOW, W)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await fileIftaReturn(Q, {}, NOW, W)).toMatchObject({ ok: false, code: "blocked" });
    expect(await loadSampleIftaRates(Q, NOW, W)).toMatchObject({ ok: true });
    const out = await fileIftaReturn(Q, { confirmProvisional: true }, NOW, W);
    expect(out).toMatchObject({ ok: false, code: "blocked" });
    expect(!out.ok && out.error).toContain("Sample rates");
    expect(await prisma.iftaReturn.count({ where: { workspaceId: W } })).toBe(0);
    expect(await clearIftaRates(Q, NOW, W)).toMatchObject({ ok: true });
  });

  test("provisional rates file only with the confirmation; the snapshot is the return, exactly", async () => {
    expect(await commitIftaRates(RATES, null, Q, "provisional", "q3-prov.csv", NOW, W)).toMatchObject({ ok: true });
    expect(await fileIftaReturn(Q, {}, NOW, W)).toMatchObject({ ok: false, code: "confirm_provisional" });
    const live = await iftaReturn(Q, NOW, W);
    if (!live.ok) throw new Error(live.error);
    const out = await fileIftaReturn(Q, { confirmProvisional: true }, NOW, W);
    expect(out).toMatchObject({ ok: true, total: "1.89", amended: false });
    const { filed, history } = await iftaFiling(Q, W);
    expect(filed).toMatchObject({ quarter: Q, rateState: "provisional", provisionalConfirmed: true, dueDate: "2026-10-31", miles: "2500.0", gallons: "400.000", bulkGallons: "50.000", mpg: "6.25", tax: "1.89", total: "1.89", trucks: 1, amends: false });
    expect(filed!.lines).toEqual(live.lines.map(({ name: _n, ...l }) => l));
    expect(returnDrift(filed!, live).changed).toBe(false);
    expect(history).toHaveLength(1);
    expect(await audits("ifta_return_filed")).toBe(1);
  });

  test("one filed return a quarter, and the figures can never be edited", async () => {
    expect(await fileIftaReturn(Q, { confirmProvisional: true }, NOW, W)).toMatchObject({ ok: false, code: "already_filed" });
    const row = await prisma.iftaReturn.findFirstOrThrow({ where: { workspaceId: W, status: "filed" }, include: { lines: true } });
    await expect(prisma.iftaReturn.update({ where: { id: row.id }, data: { total: 0 } })).rejects.toThrow();
    await expect(prisma.iftaReturn.update({ where: { id: row.id }, data: { status: "reopened", reopenedAt: NOW, reopenedBy: "x", reopenReason: "y", tax: 5 } })).rejects.toThrow();
    await expect(prisma.iftaReturnLine.update({ where: { id: row.lines[0]!.id }, data: { total: 0 } })).rejects.toThrow();
    // A second filed row for the quarter, written past the code, meets the partial unique index.
    const { id: _id, lines: _l, createdAt: _c, ...copy } = row;
    await expect(prisma.iftaReturn.create({ data: { ...copy } })).rejects.toThrow();
  });

  test("the quarter is locked: rates, miles and a fuel file with a purchase in it all refuse", async () => {
    const locked = { ok: false, error: `${Q} is filed. Reopen the return on IFTA first if this really needs to change.` };
    expect(await commitIftaRates(RATES, null, Q, "final", "q3-final.csv", NOW, W)).toEqual(locked);
    expect(await clearIftaRates(Q, NOW, W)).toEqual(locked);
    expect(await loadSampleIftaRates(Q, NOW, W)).toEqual(locked);
    expect(await syncIftaMileage(Q, NOW, W)).toMatchObject({ ok: false, code: "filed" });
    expect(await calculateIfta(Q, W, NOW)).toMatchObject({ ok: false, code: "filed" });
    const fuel = await removeFuelImport(BATCH_IN, NOW, W);
    expect(fuel).toMatchObject({ ok: false });
    expect(!fuel.ok && fuel.error).toContain(`${Q} is filed`);
    // Another quarter is not locked.
    expect(await removeFuelImport(BATCH_OUT, NOW, W)).toEqual({ ok: true, removed: 1 });
    expect(await prisma.iftaRate.count({ where: { workspaceId: W, quarter: Q } })).toBe(3);
    expect(await prisma.iftaMileage.count({ where: { workspaceId: W, quarter: Q } })).toBe(3);
  });

  test("a late receipt shows as changed since filed, with the change", async () => {
    await fill("OK", 100, "2026-09-20T12:00:00Z");
    const live = await iftaReturn(Q, NOW, W);
    if (!live.ok) throw new Error(live.error);
    const { filed } = await iftaFiling(Q, W);
    const d = returnDrift(filed!, live);
    expect(d.changed).toBe(true);
    expect(d.header.find((f) => f.field === "gallons")).toMatchObject({ filed: "400.000", now: "500.000", delta: "100" });
    expect(d.header.find((f) => f.field === "mpg")).toMatchObject({ filed: "6.25", now: "5.00" });
    expect(d.lines.find((l) => l.jurisdiction === "OK")!.fields.map((f) => f.field)).toContain("taxPaidGallons");
    // The filed numbers did not move.
    expect((await iftaFiling(Q, W)).filed!.total).toBe("1.89");
  });

  test("reopened with a reason, the quarter is free; filing again is an amendment of it", async () => {
    expect(await reopenIftaReturn(Q, "no", NOW, W)).toMatchObject({ ok: false });
    expect(await reopenIftaReturn(Q, "Late fuel receipt from the card company", NOW, W)).toEqual({ ok: true });
    expect(await reopenIftaReturn(Q, "Again for no reason", NOW, W)).toMatchObject({ ok: false });
    const first = await prisma.iftaReturn.findFirstOrThrow({ where: { workspaceId: W } });
    expect(first).toMatchObject({ status: "reopened", reopenReason: "Late fuel receipt from the card company", reopenedBy: expect.any(String) });
    // Unlocked: final rates can land now.
    expect(await commitIftaRates(RATES, null, Q, "final", "q3-final.csv", NOW, W)).toMatchObject({ ok: true });
    // Two filings at once: one wins.
    const both = await Promise.all([fileIftaReturn(Q, {}, NOW, W), fileIftaReturn(Q, {}, NOW, W)]);
    expect(both.filter((b) => b.ok)).toHaveLength(1);
    expect(both.find((b) => !b.ok)).toMatchObject({ code: "already_filed" });
    const { filed, history } = await iftaFiling(Q, W);
    expect(filed).toMatchObject({ rateState: "final", provisionalConfirmed: false, amends: true, gallons: "500.000" });
    expect(history.map((h) => h.status)).toEqual(["filed", "reopened"]);
    const second = await prisma.iftaReturn.findFirstOrThrow({ where: { workspaceId: W, status: "filed" } });
    expect(second.amendsId).toBe(first.id);
    expect([await audits("ifta_return_reopened"), await audits("ifta_return_amended"), await audits("ifta_return_filed")]).toEqual([1, 1, 1]);
  });
});
