import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/import-csv";
import { invoiceLoad, issueCreditMemo, markLoadPaid, undoPaid, voidCreditMemo } from "@/server/tl/invoicing";
import { saveFactoringTerms } from "@/server/partners/factoring-terms";
import { applyFactoringUpdate, recordChargeback } from "@/server/partners/factoring";
import { journalFile } from "@/server/partners/accounting";

/**
 * Money plan Wave 6, step 1, on the demo database in a workspace of its own: the day the factor released the reserve and the day it charged an invoice back are kept on the invoice
 * (factoringReserveReleasedAt, factoringChargedBackAt), set on every path that makes them true and cleared on every path that takes them back, so a re-opened invoice never keeps a
 * stale date. And gap 6, rule 2: a quick-pay or factor fee taken short is booked to Factoring Fees in the journal.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/factoring-dates.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "factoring-dates";
const T0 = new Date("2026-11-20T18:00:00Z");
const later = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const TERMS = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };
const FORM = { terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };

describe.skipIf(!run)("factoring dates and the fee account", () => {
  const loads: Record<string, string> = {};
  const rec = (n: string) => prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: `FD-${n}` } });
  const dates = async (n: string) => {
    const r = await rec(n);
    return { status: r.factoringStatus, released: r.factoringReserveReleased?.toNumber() ?? null, releasedAt: r.factoringReserveReleasedAt?.toISOString() ?? null, chargedBackAt: r.factoringChargedBackAt?.toISOString() ?? null };
  };
  const fund = async (n: string, at: Date) => {
    const r = await rec(n);
    await prisma.invoice.update({ where: { id: r.id }, data: { factoringStatus: "submitted" } });
    await prisma.load.update({ where: { id: loads[n]! }, data: { factoringStatus: "submitted" } });
    expect(await applyFactoringUpdate(loads[n]!, "funded", `APX-${n}`, at, W)).toBe(true);
  };

  beforeAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Factoring dates desk", plan: "enterprise", timezone: "America/Chicago" } as never });
    expect(await saveFactoringTerms(TERMS, "test", T0, W)).toMatchObject({ ok: true });
    for (const n of ["P", "S", "C", "M", "Q"]) {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `FDL-${n}`, brokerName: "Acme Logistics", status: "completed", completedAt: T0, quotedRevenue: 1000, podNote: "Signed" } as never });
      loads[n] = l.id;
      expect(await invoiceLoad(l.id, { form: { ...FORM, number: `FD-${n}` } }, T0, W)).toMatchObject({ ok: true });
    }
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("the customer paying a funded invoice releases the reserve on the payment's day; taking that payment back clears it; paying again sets it again", async () => {
    await fund("P", later(1));
    expect(await dates("P")).toEqual({ status: "funded", released: null, releasedAt: null, chargedBackAt: null });
    expect(await markLoadPaid(loads.P!, later(48), { source: "factor", payer: "Apex Capital", shortAction: "balance" }, W)).toMatchObject({ ok: true });
    expect(await dates("P")).toEqual({ status: "paid", released: 75, releasedAt: later(48).toISOString(), chargedBackAt: null });
    expect(await undoPaid(loads.P!, "Entered on the wrong invoice", later(49), W)).toMatchObject({ ok: true });
    expect(await dates("P")).toEqual({ status: "funded", released: null, releasedAt: null, chargedBackAt: null });
    expect(await markLoadPaid(loads.P!, later(72), { source: "factor", payer: "Apex Capital", shortAction: "balance" }, W)).toMatchObject({ ok: true });
    expect(await dates("P")).toEqual({ status: "paid", released: 75, releasedAt: later(72).toISOString(), chargedBackAt: null });
  });

  test("the factor reporting paid releases the reserve on the day it says so", async () => {
    await fund("S", later(1));
    expect(await applyFactoringUpdate(loads.S!, "paid", null, later(30), W)).toBe(true);
    expect(await dates("S")).toEqual({ status: "paid", released: 75, releasedAt: later(30).toISOString(), chargedBackAt: null });
  });

  test("a chargeback keeps its own day, clears any release, and a later payment by the customer does not move it", async () => {
    await fund("C", later(1));
    expect(await recordChargeback(loads.C!, "Customer did not pay in 90 days", later(100), W)).toMatchObject({ ok: true });
    expect(await dates("C")).toEqual({ status: "rejected", released: null, releasedAt: null, chargedBackAt: later(100).toISOString() });
    expect(await markLoadPaid(loads.C!, later(200), { source: "desk", shortAction: "balance" }, W)).toMatchObject({ ok: true });
    const r = await rec("C");
    expect([r.status, r.factoringStatus, r.factoringChargedBackAt?.toISOString(), r.factoringReserveReleasedAt]).toEqual(["paid", "rejected", later(100).toISOString(), null]);
  });

  test("a credit memo cannot close a funded invoice (so no credit path sets a release); a memo voided on an unfactored invoice leaves no factoring date", async () => {
    await fund("M", later(1));
    expect(await issueCreditMemo(loads.M!, { amount: 1000, reason: "Load refused, billed in error" }, later(5), W)).toMatchObject({ ok: false, error: expect.stringContaining("with a factoring company") });
    expect(await dates("M")).toEqual({ status: "funded", released: null, releasedAt: null, chargedBackAt: null });
    // Voiding a credit memo reopens the original: on an invoice no factor has, nothing factoring-dated is set or left.
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "FDL-N", brokerName: "Acme Logistics", status: "completed", completedAt: T0, quotedRevenue: 500, podNote: "Signed" } as never });
    expect(await invoiceLoad(l.id, { form: { ...FORM, number: "FD-N" } }, T0, W)).toMatchObject({ ok: true });
    expect(await issueCreditMemo(l.id, { amount: 500, reason: "Load refused, billed in error" }, later(5), W)).toMatchObject({ ok: true });
    const memo = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, kind: "credit_memo", creditOfId: (await rec("N")).id } });
    expect(await voidCreditMemo(memo.id, "Issued by mistake", later(6), W)).toMatchObject({ ok: true });
    expect(await dates("N")).toEqual({ status: "none", released: null, releasedAt: null, chargedBackAt: null });
  });

  test("gap 6, rule 2: a quick-pay fee taken short is booked to Factoring Fees in the journal, and the release is booked on its stored day", async () => {
    expect(await markLoadPaid(loads.Q!, later(24), { amount: 980, source: "desk", shortAction: "writeoff", shortReason: "Quick pay, 2%", shortCode: "quick_pay_fee" }, W)).toMatchObject({ ok: true });
    const q = await rec("Q");
    expect([q.writeOffAmount?.toNumber(), q.writeOffCode]).toEqual([20, "quick_pay_fee"]);
    const file = await journalFile({}, W);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    const [head, ...rows] = parseCsv(file.csv);
    const col = (name: string) => head!.indexOf(name);
    const of = (id: string) => rows.filter((r) => r[col("Journal entry")] === id);
    const wo = of(`write_off:${q.id}`);
    expect(wo.map((r) => [r[col("Account")], r[col("Debit")], r[col("Credit")], r[col("Memo")]])).toEqual([
      ["Factoring Fees", "20.00", "", "Quick-pay fee taken short on FD-Q"],
      ["Accounts Receivable", "", "20.00", "Quick-pay fee taken short on FD-Q"]
    ]);
    const s = await rec("S");
    expect(of(`factoring_release:${s.id}`).map((r) => r[col("Date")])).toEqual(["2026-11-21", "2026-11-21"]);
    // Nothing in this workspace was booked to Short pays written off.
    expect(rows.filter((r) => r[col("Account")] === "Bad Debt")).toEqual([]);
  });
});
