import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { saveDriverTax } from "@/server/tl/fleet";
import { contractor1099, form1099Csv, yearBounds } from "@/server/tl/form1099";

/**
 * The yearly contractor 1099 totals read from the statement rows (docs/MONEY_PLAN.md, Wave 4 step 2). A workspace of its own on the Pacific clock (not the desk's default Central), so the
 * year's edge is the workspace's own:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/form1099.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "f1099-w";
const ZONE = "America/Los_Angeles";

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

type Line = [kind: string, amount: number];
let seq = 0;
async function statement(driverId: string, status: string, lines: Line[], at: { paidAt?: string; finalizedAt?: string } = {}) {
  seq += 1;
  const total = lines.reduce((n, [, a]) => n + Math.round(a * 100), 0) / 100;
  return prisma.settlement.create({
    data: {
      workspaceId: W,
      driverId,
      number: `F-${seq}`,
      status,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-07T00:00:00Z"),
      total,
      finalizedAt: status === "draft" ? null : new Date(at.finalizedAt ?? "2026-01-10T17:00:00Z"),
      paidAt: at.paidAt ? new Date(at.paidAt) : null,
      paidMethod: at.paidAt ? "check" : null,
      lineRows: { create: lines.map(([kind, amount], i) => ({ workspaceId: W, sort: i, kind, label: kind, amount })) }
    }
  });
}

describe.skipIf(!run)("contractor 1099 totals", () => {
  const id: Record<string, string> = {};

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "1099 desk", plan: "enterprise", timezone: ZONE } });
    const mk = async (key: string, data: Record<string, unknown>) => (id[key] = (await prisma.driver.create({ data: { workspaceId: W, name: key, ...data } })).id);
    await mk("Ana", { payrollWorkerType: "contractor", legalName: "Ana Ruiz LLC", tinType: "ein", tinLast4: "0042", tinStatus: "verified", taxAddressLine1: "1 Elm St", taxCity: "Fresno", taxState: "CA", taxZip: "93650" });
    await mk("Ben", { payrollWorkerType: "contractor" });
    await mk("Cal", { payrollWorkerType: "employee" });
    await mk("Dee", { payrollWorkerType: "contractor", tinType: "ssn", tinLast4: "7777", tinStatus: "collected" });

    // Ana: over the threshold, with a bonus, a fuel card purchase and a negative adjustment (gross and net differ).
    await statement(id.Ana!, "final", [["load", 1800], ["adjustment", 300], ["fuel", -400.1], ["adjustment", -50]], { paidAt: "2026-06-15T17:00:00Z" });
    // Paid at 9 pm on 31 December in Los Angeles, already 1 January in UTC: 2026's.
    await statement(id.Ana!, "final", [["load", 100.05]], { paidAt: "2027-01-01T05:00:00Z" });
    // Voided (and, against the rules, stamped paid): never counted.
    await statement(id.Ana!, "void", [["load", 9999]], { paidAt: "2026-05-01T17:00:00Z" });
    // A draft: never counted.
    await statement(id.Ana!, "draft", [["load", 5000]]);
    // Ben: under the threshold in 2026; 1 am on 1 January in Los Angeles is 2027's.
    await statement(id.Ben!, "final", [["load", 500]], { paidAt: "2026-03-01T17:00:00Z" });
    await statement(id.Ben!, "final", [["load", 1700]], { paidAt: "2027-01-01T09:00:00Z", finalizedAt: "2026-12-28T17:00:00Z" });
    // Ben: finalized in December, not paid yet.
    await statement(id.Ben!, "final", [["load", 321.45]], { finalizedAt: "2026-12-20T17:00:00Z" });
    // Cal is W-2: payroll files his, never here.
    await statement(id.Cal!, "final", [["load", 5000]], { paidAt: "2026-04-01T17:00:00Z" });
    // Dee: exactly the threshold ("or more"), with no legal name or address.
    await statement(id.Dee!, "final", [["load", 2000]], { paidAt: "2026-08-01T17:00:00Z" });
  });
  afterAll(wipe);

  test("the year runs midnight to midnight in the workspace's zone", () => {
    const b = yearBounds(2026, ZONE);
    expect(b.from.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(b.to.toISOString()).toBe("2027-01-01T08:00:00.000Z");
  });

  test("contractors paid in the year: gross before money off, net after, the threshold on gross", async () => {
    const r = await contractor1099(2026, {}, W);
    expect(r.threshold).toBe(2000);
    expect(r.note).toContain("confirm with your accountant");
    expect(r.zone).toBe(ZONE);
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(Object.keys(by).sort()).toEqual(["Ana", "Ben", "Dee"]); // Cal (W-2) is left out

    // 1800 + 300 + 100.05 gross; net takes off 400.10 fuel and the 50 adjustment.
    expect(by.Ana).toMatchObject({ gross: 2200.05, net: 1749.95, statements: 2, overThreshold: true, gaps: [], legalName: "Ana Ruiz LLC", legalNameMissing: false, tinType: "ein", tinLast4: "0042", tinStatus: "verified", address: "1 Elm St, Fresno, CA 93650", rowsDisagree: false });
    expect(by.Ben).toMatchObject({ gross: 500, net: 500, statements: 1, overThreshold: false, legalName: "Ben", legalNameMissing: true });
    expect(by.Dee).toMatchObject({ gross: 2000, net: 2000, overThreshold: true, legalNameMissing: true, gaps: ["legal name", "mailing address"] });

    expect(r.totals).toMatchObject({ contractors: 3, over: 2, incompleteOver: 1, gross: 4700.05, net: 4249.95, statements: 4 });
    // Finalized and not paid: apart, not in the totals.
    expect(r.unpaid).toMatchObject({ count: 1, total: 321.45 });
    expect(r.unpaid.rows[0]).toMatchObject({ driverName: "Ben", total: 321.45 });
  });

  test("the statement paid on 1 January (Pacific) is the next year's", async () => {
    const r = await contractor1099(2027, {}, W);
    expect(r.rows.map((x) => [x.name, x.gross])).toEqual([["Ben", 1700]]);
    expect(r.threshold).toBe(2000);
    expect((await contractor1099(2025, {}, W)).rows).toEqual([]);
    expect((await contractor1099(2025, {}, W)).threshold).toBe(600);
  });

  test("the CSV carries the screen's figures and the threshold note", async () => {
    const r = await contractor1099(2026, {}, W);
    const csv = form1099Csv(r);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toContain("Gross compensation,Net paid,Statements,Over threshold,Threshold used (confirm with your accountant)");
    const ana = lines.find((l) => l.startsWith("Ana Ruiz LLC,"))!;
    expect(ana).toBe("Ana Ruiz LLC,Ana,EIN,0042,Verified,\"1 Elm St, Fresno, CA 93650\",2200.05,1749.95,2,Yes,2000,");
    const dee = lines.find((l) => l.startsWith("Dee,"))!;
    expect(dee).toContain(",2000,2000,1,Yes,2000,legal name; mailing address");
    // Every row's gross and net add up to the screen's totals.
    const rows = r.rows.map((x) => lines.find((l) => l.includes(`,${x.gross},${x.net},${x.statements},`)));
    expect(rows.every(Boolean)).toBe(true);
    expect(csv).toContain("confirm with your accountant");
    expect(csv).toContain("Finalized, not paid yet (not counted): 1 statements, 321.45.");
  });

  test("a full nine-digit TIN is refused by the save and by the database; the audit keeps the last four only", async () => {
    const full = await saveDriverTax({ tinType: "ssn", tinLast4: "123-45-6789" }, id.Ben!, new Date(), W);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.errors?.tinLast4).toContain("Only the last four digits");
    await expect(prisma.driver.update({ where: { id: id.Ben! }, data: { tinLast4: "123456789" } })).rejects.toThrow();
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: id.Ben! } })).tinLast4).toBeNull();

    const ok = await saveDriverTax({ legalName: "Benjamin Ortiz", tinType: "ssn", tinLast4: "6789", tinStatus: "collected", taxAddressLine1: "9 Oak Ave", taxCity: "Reno", taxState: "nv", taxZip: "89501" }, id.Ben!, new Date(), W);
    expect(ok).toMatchObject({ ok: true, changed: true });
    const d = await prisma.driver.findUniqueOrThrow({ where: { id: id.Ben! } });
    expect(d).toMatchObject({ legalName: "Benjamin Ortiz", tinType: "ssn", tinLast4: "6789", tinStatus: "collected", taxState: "NV" });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "driver_tax_changed" } });
    expect((audit.after as Record<string, unknown>).TIN).toBe("SSN ending 6789");
    // Nothing of the refused full number reached the log.
    const all = await prisma.auditEvent.findMany({ where: { workspaceId: W } });
    expect(JSON.stringify(all)).not.toMatch(/12345|6789\d|123-45/);
    // Saving the same again changes nothing.
    expect(await saveDriverTax({ legalName: "Benjamin Ortiz", tinType: "ssn", tinLast4: "6789", tinStatus: "collected", taxAddressLine1: "9 Oak Ave", taxCity: "Reno", taxState: "NV", taxZip: "89501" }, id.Ben!, new Date(), W)).toMatchObject({ ok: true, changed: false });
  });
});
