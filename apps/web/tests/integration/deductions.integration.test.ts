import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { saveDeduction, setDeductionActive, driverDeductions } from "@/server/tl/deductions";
import { contractor1099 } from "@/server/tl/form1099";
import { finalizeSettlement, getSettlement, listSettlements, markSettlementPaid, saveDraft, startSettlement, voidSettlement, type Draft } from "@/server/tl/settlement";

/**
 * Recurring deductions and escrow on real statements (docs/MONEY_PLAN.md, Wave 4 step 3, rule K): proposed on a draft, skipped with a reason, escrow stopping at its goal, a cap, the
 * below-zero confirmation, the ledger written at finalize and removed at void (and a void refused when its escrow was already paid back), rows that add up, and the 1099 counting each kind once.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/deductions.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ded-w";
const noon = (d: string) => new Date(`${d}T17:00:00Z`);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

const blank = (over: Partial<Draft> = {}): Draft => ({ hours: {}, adjustments: [], ...over });

describe.skipIf(!run)("recurring deductions and escrow", () => {
  let driverId = "";
  let employeeId = "";
  const rule: Record<string, string> = {};
  const st: Record<string, string> = {};

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Deductions desk", plan: "enterprise" } });
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 7", type: "heavy_duty" } });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "Owner Op", payrollWorkerType: "contractor", assignedVehicleId: truck.id } })).id;
    employeeId = (await prisma.driver.create({ data: { workspaceId: W, name: "Company Driver", payrollWorkerType: "employee" } })).id;
    // One load a week: $800, $400, $400 at $0.50 a mile.
    for (const [n, day, miles] of [["D-1", "2026-10-06", 1600], ["D-2", "2026-10-13", 800], ["D-3", "2026-10-20", 800]] as const)
      await prisma.load.create({ data: { workspaceId: W, vehicleId: truck.id, loadNumber: n, status: "completed", completedAt: noon(day), quotedRevenue: 2000, loadedMiles: miles, originAddress: "Dallas, TX", destinationAddress: "Austin, TX", assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "E-1", status: "completed", completedAt: noon("2026-10-06"), quotedRevenue: 900, loadedMiles: 400, originAddress: "Dallas, TX", destinationAddress: "Waco, TX", assignment: { create: { driverId: employeeId, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
  });
  afterAll(wipe);

  test("rules are set up for a contractor, never for a W-2 employee", async () => {
    for (const [key, values] of [
      ["lease", { kind: "lease", label: "Truck lease", amount: "300" }],
      ["escrow", { kind: "escrow", label: "Escrow", amount: "200", goal: "300" }],
      ["ins", { kind: "insurance", label: "Occupational accident", amount: "100", goal: "150" }]
    ] as const) {
      const out = await saveDeduction(values, driverId, null, new Date(), W);
      expect(out.ok, key).toBe(true);
      if (out.ok) rule[key] = out.id;
    }
    const emp = await saveDeduction({ kind: "lease", label: "Lease", amount: "100" }, employeeId, null, new Date(), W);
    expect(emp).toMatchObject({ ok: false, error: expect.stringContaining("payroll") });
  });

  test("week 1: offered on the draft; a skip needs a reason; finalized, the ledger and rows are written together", async () => {
    const start = await startSettlement({ driverId, start: "2026-10-05", end: "2026-10-11" }, new Date(), W);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    st.w1 = start.id;
    const view = (await getSettlement(st.w1, W))!;
    expect(view.deductionOptions.map((o) => [o.label, o.proposedCents])).toEqual([["Truck lease", 30000], ["Escrow", 20000], ["Occupational accident", 10000]]);
    expect(view.statement).toMatchObject({ loadsTotal: 800, deductionsTotal: -600, total: 200 });

    expect(await saveDraft(st.w1, blank({ deductions: { skips: { [rule.ins!]: "" }, release: null } }), W)).toMatchObject({ ok: false, errors: { [`skip.${rule.ins}`]: expect.any(String) } });
    const choices = { skips: { [rule.ins!]: "Short week" }, release: null };
    expect(await saveDraft(st.w1, blank({ deductions: choices }), W)).toMatchObject({ ok: true });
    expect((await getSettlement(st.w1, W))!.deductionChoices).toEqual(choices);
    expect(await finalizeSettlement(st.w1, blank({ deductions: choices }), new Date(), W, 300)).toMatchObject({ ok: true });

    const rows = await prisma.settlementLine.findMany({ where: { settlementId: st.w1 }, orderBy: { sort: "asc" } });
    expect(rows.map((r) => [r.kind, r.amount.toString(), r.deductionId])).toEqual([["load", "800", null], ["deduction", "-300", rule.lease], ["escrow", "-200", rule.escrow]]);
    const ledger = await prisma.driverLedgerEntry.findMany({ where: { settlementId: st.w1 }, orderBy: { kind: "asc" } });
    expect(ledger.map((e) => [e.kind, e.amount.toString(), e.deductionId])).toEqual([["deduction", "-300", rule.lease], ["escrow", "-200", rule.escrow]]);
    const final = (await getSettlement(st.w1, W))!;
    expect(final.statement).toMatchObject({ total: 300, deductionsTotal: -500 });
    expect(final.statement.deductions.map((d) => d.kind)).toEqual(["deduction", "escrow"]);
  });

  test("week 2: escrow stops at its goal; below zero is refused until a person confirms it", async () => {
    const start = await startSettlement({ driverId, start: "2026-10-12", end: "2026-10-18" }, new Date(), W);
    if (!start.ok) throw new Error("no statement");
    st.w2 = start.id;
    const view = (await getSettlement(st.w2, W))!;
    expect(view.escrowHeldCents).toBe(20000);
    expect(view.deductionOptions.map((o) => o.proposedCents)).toEqual([30000, 10000, 10000]); // escrow only $100 more to its $300 goal
    expect(view.statement).toMatchObject({ total: -100, needsConfirm: true });
    const refused = await finalizeSettlement(st.w2, blank(), new Date(), W, -100);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("below zero") });
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: st.w2 } })).toMatchObject({ status: "draft" });
    expect(await finalizeSettlement(st.w2, blank(), new Date(), W, -100, true)).toMatchObject({ ok: true });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "statement_finalized", summary: { contains: (await prisma.settlement.findUniqueOrThrow({ where: { id: st.w2 } })).number } } });
    expect(JSON.stringify(audit.after)).toContain("Below zero");
  });

  test("week 3: escrow is full, the cap takes only what is left, and a release is no more than is held", async () => {
    const start = await startSettlement({ driverId, start: "2026-10-19", end: "2026-10-25" }, new Date(), W);
    if (!start.ok) throw new Error("no statement");
    st.w3 = start.id;
    const view = (await getSettlement(st.w3, W))!;
    expect(view.escrowHeldCents).toBe(30000);
    expect(view.deductionOptions.map((o) => [o.label, o.proposedCents, o.note])).toEqual([
      ["Truck lease", 30000, null],
      ["Escrow", 0, "Escrow has reached its $300.00 goal."],
      ["Occupational accident", 5000, "Only $50.00 left under its $150.00 cap."]
    ]);
    expect(await saveDraft(st.w3, blank({ deductions: { skips: {}, release: { amount: "500", reason: "Lease ended" } } }), W)).toMatchObject({ ok: false, errors: { "release.amount": "Only $300.00 is held in escrow." } });
    const release = { skips: {}, release: { amount: "250", reason: "Lease ended" } };
    expect(await finalizeSettlement(st.w3, blank({ deductions: release }), new Date(), W, 300)).toMatchObject({ ok: true });
    const d = await driverDeductions(driverId, W);
    expect(d.escrowHeldCents).toBe(5000);
    expect(d.rules.find((r) => r.rule.id === rule.ins)!.soFarCents).toBe(15000);
    const relRow = await prisma.driverLedgerEntry.findFirstOrThrow({ where: { settlementId: st.w3, kind: "escrow_release" } });
    expect(relRow).toMatchObject({ reason: "Lease ended" });
    expect(relRow.amount.toString()).toBe("250");
  });

  test("the list and its rows agree; a stopped rule is no longer offered", async () => {
    const rows = await listSettlements(W, { status: "final" });
    const total = (id: string) => rows.find((r) => r.id === id)!;
    expect(total(st.w1!)).toMatchObject({ total: 300, deductionsTotal: -500 });
    expect(total(st.w3!)).toMatchObject({ total: 300, deductionsTotal: -100 });
    for (const id of [st.w1!, st.w2!, st.w3!]) {
      const sum = await prisma.settlementLine.aggregate({ where: { settlementId: id }, _sum: { amount: true } });
      const s = await prisma.settlement.findUniqueOrThrow({ where: { id } });
      expect(sum._sum.amount!.toString()).toBe(s.total!.toString());
    }
    expect(await setDeductionActive(rule.lease!, false, new Date(), W)).toEqual({ ok: true });
  });

  test("the 1099 counts loads as gross, deductions and escrow as money off, the release in net only", async () => {
    for (const id of [st.w1!, st.w3!]) expect(await markSettlementPaid(id, { paidOn: "2026-10-30", method: "check" }, new Date("2026-11-01T12:00:00Z"), W)).toMatchObject({ ok: true });
    const r = await contractor1099(2026, {}, W);
    const row = r.rows.find((x) => x.driverId === driverId)!;
    expect(row).toMatchObject({ gross: 1200, net: 600, statements: 2, unknownKinds: [], rowsDisagree: false });
    expect(r.rows.some((x) => x.driverId === employeeId)).toBe(false);
  });

  test("void removes only that statement's ledger rows; a void that would leave escrow below zero is refused", async () => {
    // Held: week 1 $200 + week 2 $100 - week 3's $250 release = $50. Voiding week 2 would leave $200 - $250: refused.
    const v2 = await voidSettlement(st.w2!, "Wrong week", new Date(), W);
    expect(v2).toMatchObject({ ok: false, error: expect.stringContaining("already paid back") });
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w2 } })).toBe(3);
    // Take the paid mark off week 3 (as if it had not been paid yet), void it, then week 2 voids.
    await prisma.settlement.update({ where: { id: st.w3! }, data: { paidAt: null, paidMethod: null } });
    expect(await voidSettlement(st.w3!, "Release on the wrong statement", new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w3 } })).toBe(0);
    expect(await prisma.settlementLine.count({ where: { settlementId: st.w3 } })).toBeGreaterThan(0); // rule J: the rows stay
    expect(await voidSettlement(st.w2!, "Wrong week", new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w2 } })).toBe(0);
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w1 } })).toBe(2);
    expect((await driverDeductions(driverId, W)).escrowHeldCents).toBe(20000);
  });

  test("two statements finalized at once never take escrow past its goal or a deduction past its cap", async () => {
    // Held $200 of a $300 goal; insurance has taken $0 of its $150 cap. Both drafts read that before either finalizes.
    const a = await startSettlement({ driverId, start: "2026-10-12", end: "2026-10-18" }, new Date(), W);
    const b = await startSettlement({ driverId, start: "2026-10-19", end: "2026-10-25" }, new Date(), W);
    if (!a.ok || !b.ok) throw new Error("no statements");
    const out = await Promise.all([finalizeSettlement(a.id, blank(), new Date(), W, null, true), finalizeSettlement(b.id, blank(), new Date(), W, null, true)]);
    // Either the second saw the first's ledger (both finalize, the second taking less) or it was refused to be reviewed; never both at the stale figures.
    for (const o of out) if (!o.ok) expect(o.error).toContain("changed while you were looking");
    const d = await driverDeductions(driverId, W);
    expect(d.escrowHeldCents).toBeLessThanOrEqual(30000);
    expect(d.rules.find((r) => r.rule.id === rule.ins)!.soFarCents).toBeLessThanOrEqual(15000);
    expect(out.some((o) => o.ok)).toBe(true);
  });

  test("an employee's draft is offered no deductions", async () => {
    const start = await startSettlement({ driverId: employeeId, start: "2026-10-05", end: "2026-10-11" }, new Date(), W);
    if (!start.ok) throw new Error("no statement");
    const view = (await getSettlement(start.id, W))!;
    expect(view.deductionOptions).toEqual([]);
    expect(view.statement.deductions).toEqual([]);
  });
});
