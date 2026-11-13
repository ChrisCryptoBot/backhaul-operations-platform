import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { driverDeductions, recordAdvance, setAdvanceActive } from "@/server/tl/deductions";
import { contractor1099 } from "@/server/tl/form1099";
import { finalizeSettlement, getSettlement, markSettlementPaid, startSettlement, voidSettlement, type Draft } from "@/server/tl/settlement";

/**
 * Advances on real statements (docs/MONEY_PLAN.md, Wave 4 step 4): recorded with their ledger entry, repaid by a proposed line until cleared and never past what is owed (also when two
 * statements finalize at once), rule K when a repayment takes a statement below zero, void removing only that statement's repayment (rows stay, rule J) and refusing one that would break an
 * advance's balance, and the 1099 counting the repayment as pass-through.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/advances.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "adv-w";
const noon = (d: string) => new Date(`${d}T17:00:00Z`);
const NOW = new Date("2026-11-12T18:00:00Z");
const blank = (over: Partial<Draft> = {}): Draft => ({ hours: {}, adjustments: [], ...over });

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("advances", () => {
  let driverId = "";
  let employeeId = "";
  const adv: Record<string, string> = {};
  const st: Record<string, string> = {};
  const owedOf = async (id: string) => (await driverDeductions(driverId, W)).advances.find((a) => a.advance.id === id)!.owedCents;

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Advances desk", plan: "enterprise" } });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "Owner Op", payrollWorkerType: "contractor" } })).id;
    employeeId = (await prisma.driver.create({ data: { workspaceId: W, name: "Company Driver", payrollWorkerType: "employee" } })).id;
    // A $400 load each week ($0.50 a mile x 800).
    for (const [n, day] of [["A-1", "2026-10-06"], ["A-2", "2026-10-13"], ["A-3", "2026-10-20"], ["A-4", "2026-10-27"]] as const)
      await prisma.load.create({ data: { workspaceId: W, loadNumber: n, status: "completed", completedAt: noon(day), quotedRevenue: 2000, loadedMiles: 800, originAddress: "Dallas, TX", destinationAddress: "Austin, TX", assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
  });
  afterAll(wipe);

  test("recorded with its ledger entry; never for a W-2 employee or a day ahead", async () => {
    const out = await recordAdvance({ amount: "500", givenOn: "2026-10-03", method: "cash", repay: "300", note: "Tires" }, driverId, NOW, W);
    expect(out.ok).toBe(true);
    if (out.ok) adv.one = out.id;
    const e = await prisma.driverLedgerEntry.findFirstOrThrow({ where: { advanceId: adv.one, kind: "advance" } });
    expect(e.amount.toString()).toBe("500");
    expect(e.settlementId).toBeNull();
    expect(await owedOf(adv.one!)).toBe(50000);
    expect(await recordAdvance({ amount: "100", givenOn: "2026-10-03", method: "cash", repay: "50" }, employeeId, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("payroll") });
    expect(await recordAdvance({ amount: "100", givenOn: "2026-11-20", method: "cash", repay: "50" }, driverId, NOW, W)).toMatchObject({ ok: false, errors: { givenOn: expect.any(String) } });
  });

  test("week 1 repays the set amount; the repayment is a row and a ledger entry of that statement", async () => {
    const s = await startSettlement({ driverId, start: "2026-10-05", end: "2026-10-11" }, NOW, W);
    if (!s.ok) throw new Error("no statement");
    st.w1 = s.id;
    const view = (await getSettlement(st.w1, W))!;
    expect(view.deductionOptions.map((o) => [o.source, o.proposedCents, o.soFarCents])).toEqual([["advance", 30000, 50000]]);
    expect(view.statement).toMatchObject({ total: 100, needsConfirm: false });
    expect(await finalizeSettlement(st.w1, blank(), NOW, W, 100)).toMatchObject({ ok: true });
    const row = await prisma.settlementLine.findFirstOrThrow({ where: { settlementId: st.w1, kind: "advance_repaid" } });
    expect(row).toMatchObject({ advanceId: adv.one });
    expect(row.amount.toString()).toBe("-300");
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w1, kind: "advance_repaid", advanceId: adv.one } })).toBe(1);
    expect(await owedOf(adv.one!)).toBe(20000);
    expect((await getSettlement(st.w1, W))!.statement.deductions.map((d) => [d.kind, d.advanceId])).toEqual([["advance_repaid", adv.one]]);
  });

  test("week 2 repays only what is left of the first, and a second advance takes it below zero: refused until confirmed", async () => {
    const two = await recordAdvance({ amount: "1000", givenOn: "2026-10-10", method: "fuel_card", repay: "500" }, driverId, NOW, W);
    if (!two.ok) throw new Error("no advance");
    adv.two = two.id;
    const s = await startSettlement({ driverId, start: "2026-10-12", end: "2026-10-18" }, NOW, W);
    if (!s.ok) throw new Error("no statement");
    st.w2 = s.id;
    const view = (await getSettlement(st.w2, W))!;
    expect(view.deductionOptions.map((o) => o.proposedCents)).toEqual([20000, 50000]);
    expect(view.deductionOptions[0]!.note).toBe("Only $200.00 left to repay.");
    expect(view.statement).toMatchObject({ total: -300, needsConfirm: true });
    expect(await finalizeSettlement(st.w2, blank(), NOW, W, -300)).toMatchObject({ ok: false, error: expect.stringContaining("below zero") });
    expect(await finalizeSettlement(st.w2, blank(), NOW, W, -300, true)).toMatchObject({ ok: true });
    expect(await owedOf(adv.one!)).toBe(0);
    expect(await owedOf(adv.two!)).toBe(50000);
  });

  test("two statements finalized at once never repay an advance past what is owed", async () => {
    const a = await startSettlement({ driverId, start: "2026-10-19", end: "2026-10-25" }, NOW, W);
    const b = await startSettlement({ driverId, start: "2026-10-26", end: "2026-11-01" }, NOW, W);
    if (!a.ok || !b.ok) throw new Error("no statements");
    st.w3 = a.id;
    st.w4 = b.id;
    const out = await Promise.all([finalizeSettlement(a.id, blank(), NOW, W, null, true), finalizeSettlement(b.id, blank(), NOW, W, null, true)]);
    for (const o of out) if (!o.ok) expect(o.error).toContain("changed while you were looking");
    expect(out.some((o) => o.ok)).toBe(true);
    expect(await owedOf(adv.two!)).toBe(0);
    const repaid = await prisma.driverLedgerEntry.aggregate({ where: { advanceId: adv.two, kind: "advance_repaid" }, _sum: { amount: true } });
    expect(repaid._sum.amount!.toString()).toBe("-1000");
    // A statement refused in the race is still a draft, and now offers nothing for the cleared advance.
    for (const [i, o] of out.entries()) if (!o.ok) expect((await getSettlement([a.id, b.id][i]!, W))!.deductionOptions).toEqual([]);
  });

  test("a cleared advance is no longer proposed; pausing one stops its proposal without changing what is owed", async () => {
    const three = await recordAdvance({ amount: "200", givenOn: "2026-10-20", method: "check", repay: "100" }, driverId, NOW, W);
    if (!three.ok) throw new Error("no advance");
    adv.three = three.id;
    expect(await setAdvanceActive(adv.three, false, NOW, W)).toEqual({ ok: true });
    const draft = await prisma.settlement.findFirst({ where: { workspaceId: W, status: "draft" } });
    if (draft) expect((await getSettlement(draft.id, W))!.deductionOptions).toEqual([]);
    expect(await owedOf(adv.three)).toBe(20000);
  });

  test("void takes back only that statement's repayment; its rows stay; a void that would break an advance's balance is refused", async () => {
    expect(await voidSettlement(st.w2!, "Wrong week", NOW, W)).toMatchObject({ ok: true });
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w2 } })).toBe(0);
    expect(await prisma.settlementLine.count({ where: { settlementId: st.w2, kind: "advance_repaid" } })).toBe(2); // rule J
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w1 } })).toBe(1);
    expect(await owedOf(adv.one!)).toBe(20000);
    // A chain that no longer reads true (the advance's amount cut below what voiding week 1 would put back as owed) is refused rather than left inconsistent.
    await prisma.driverAdvance.update({ where: { id: adv.one! }, data: { amount: 400, repayAmount: 300 } });
    expect(await voidSettlement(st.w1!, "Test", NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("advance") });
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: st.w1! } })).toMatchObject({ status: "final" });
    expect(await prisma.driverLedgerEntry.count({ where: { settlementId: st.w1 } })).toBe(1);
    await prisma.driverAdvance.update({ where: { id: adv.one! }, data: { amount: 500 } });
  });

  test("the 1099: a repayment is pass-through, so gross is the loads and net is the statements", async () => {
    expect(await markSettlementPaid(st.w1!, { paidOn: "2026-10-30", method: "check" }, NOW, W)).toMatchObject({ ok: true });
    const r = await contractor1099(2026, {}, W);
    expect(r.rows.find((x) => x.driverId === driverId)).toMatchObject({ gross: 400, net: 100, unknownKinds: [], rowsDisagree: false });
  });
});
