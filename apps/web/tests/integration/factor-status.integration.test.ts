import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { invoiceLoad } from "@/server/tl/invoicing";
import { saveFactoringTerms } from "@/server/partners/factoring-terms";
import { importFactorStatus } from "@/server/partners/factor-status-import";
import { factoringReconciliation } from "@/server/partners/factoring-reconciliation";

/**
 * A factor's status file (docs/MONEY_PLAN.md, Wave 2) on the demo database, in a workspace of its own: a check writes nothing, applying moves each invoice through the same steps a webhook
 * takes (funded with its advance, fee and reserve; rejected; charged back; paid by the customer, which closes the invoice and releases the reserve), the same file again changes nothing,
 * and the reconciliation totals are the sum of the invoice records.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/factor-status.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fstatus";
const NOW = new Date("2026-11-20T18:00:00Z");
const BLANK = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };

const FILE = [
  "Invoice,Reference,Status,Amount,Reason",
  "INV-A,APX-1,Funded,,", // advance worked out from the terms: 900 of 1000
  "INV-B,APX-2,Advanced,850.00,", // the advance the factor actually paid
  "INV-C,,Declined,,Duplicate submission",
  "INV-D,,Funded,,",
  "INV-D,,Charged back,,Customer did not pay in 90 days", // planned after the line above
  "INV-A,,Paid by debtor,,", // the customer paid: the invoice closes, the reserve less the fee is released
  "INV-NONE,,Funded,,", // no such invoice
  "INV-E,,Funded,,", // never sent to a factor
  "INV-B,,maybe,," // a status the desk does not know
].join("\n");

describe.skipIf(!run)("a factor's status file", () => {
  const inv: Record<string, { id: string; loadId: string }> = {};
  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Status desk", plan: "enterprise" } });
    expect(await saveFactoringTerms(BLANK, "test", NOW, W)).toMatchObject({ ok: true });
    for (const n of ["A", "B", "C", "D", "E"]) {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `S-${n}`, brokerName: "Acme Logistics", status: "completed", completedAt: NOW, quotedRevenue: 1000, podNote: "Signed" } as never });
      expect(await invoiceLoad(l.id, { form: { number: `INV-${n}`, terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, NOW, W)).toMatchObject({ ok: true });
      const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: `INV-${n}` } });
      inv[n] = { id: rec.id, loadId: l.id };
    }
    // A to D went to the factor (by API or batch); E did not.
    for (const n of ["A", "B", "C", "D"]) {
      await prisma.invoice.update({ where: { id: inv[n]!.id }, data: { factoringStatus: "submitted", factoringReferenceId: `REF-${n}` } });
      await prisma.load.update({ where: { id: inv[n]!.loadId }, data: { factoringStatus: "submitted", factoringReferenceId: `REF-${n}` } });
    }
  });
  afterAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("a check writes nothing and says what each line would do, in file order", async () => {
    const out = await importFactorStatus(FILE, { apply: false }, NOW, W);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows.map((r) => [r.line, r.invoice, r.action])).toEqual([
      [2, "INV-A", "apply"],
      [3, "INV-B", "apply"],
      [4, "INV-C", "apply"],
      [5, "INV-D", "apply"],
      [6, "INV-D", "apply"],
      [7, "INV-A", "apply"],
      [8, "INV-NONE", "error"],
      [9, "INV-E", "error"],
      [10, "INV-B", "error"]
    ]);
    expect(out.counts).toEqual({ apply: 6, already: 0, error: 3 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.A!.id } })).factoringStatus).toBe("submitted");
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: { in: ["factoring_updated", "factoring_status_imported"] } } })).toBe(0);
  });

  test("applying moves each invoice through the webhook's own steps, with the economics and the audit", async () => {
    const out = await importFactorStatus(FILE, { apply: true }, NOW, W);
    expect(out.ok && out.counts).toEqual({ apply: 6, already: 0, error: 3 });
    const get = (n: string) => prisma.invoice.findUniqueOrThrow({ where: { id: inv[n]!.id }, include: { payments: true } });
    const a = await get("A");
    expect([a.status, a.factoringStatus, a.factoringAdvance?.toNumber(), a.factoringFee?.toNumber(), a.factoringReserve?.toNumber(), a.factoringReserveReleased?.toNumber()]).toEqual(["paid", "paid", 900, 25, 100, 75]);
    expect(a.payments.map((p) => [p.source, p.amount.toNumber(), p.payer])).toEqual([["factor", 1000, "Apex Capital"]]);
    const b = await get("B");
    expect([b.factoringStatus, b.factoringAdvance?.toNumber(), b.factoringReserve?.toNumber(), b.factoringReferenceId]).toEqual(["funded", 850, 150, "APX-2"]);
    const c = await get("C");
    expect([c.factoringStatus, c.factoringChargeback]).toEqual(["rejected", null]);
    const d = await get("D");
    expect([d.factoringStatus, d.factoringChargeback?.toNumber()]).toEqual(["rejected", 900]);
    expect((await get("E")).factoringStatus).toBe("none");
    // The loads follow their invoices.
    expect((await prisma.load.findUniqueOrThrow({ where: { id: inv.A!.loadId } })).paymentStatus).toBe("paid");
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_chargeback" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_status_imported" } })).toBe(1);
  });

  test("the same file again changes nothing: every line is already so, or still cannot apply", async () => {
    const out = await importFactorStatus(FILE, { apply: true }, NOW, W);
    expect(out.ok && out.counts).toEqual({ apply: 0, already: 6, error: 3 });
    expect((await prisma.invoicePayment.count({ where: { invoiceId: inv.A!.id } }))).toBe(1);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_status_imported" } })).toBe(1);
  });

  test("a reference that names one invoice finds it; out-of-order lines are refused with why", async () => {
    const out = await importFactorStatus("Reference,Status\nAPX-2,Paid\nREF-C,Funded\n", { apply: false }, NOW, W);
    expect(out.ok && out.rows.map((r) => [r.invoice, r.action])).toEqual([["INV-B", "apply"], ["INV-C", "error"]]);
    expect(out.ok && out.rows[1]!.detail).toMatch(/not sent this invoice|charged back/);
    expect(await importFactorStatus("Invoice,Status\nINV-B,Rejected\n", { apply: false }, NOW, W)).toMatchObject({ ok: true, rows: [{ action: "error", detail: expect.stringContaining("chargeback") }] });
  });

  test("the reconciliation lists every invoice that has been with a factor, and its totals are the sum of the records", async () => {
    const { rows, totals } = await factoringReconciliation(W);
    expect(rows.map((r) => r.number).sort()).toEqual(["INV-A", "INV-B", "INV-C", "INV-D"]);
    const recs = await prisma.invoice.findMany({ where: { workspaceId: W, number: { in: ["INV-A", "INV-B", "INV-C", "INV-D"] } }, include: { payments: true } });
    const sum = (f: (r: (typeof recs)[number]) => number) => Math.round(recs.reduce((s, r) => s + f(r), 0) * 100) / 100;
    expect(totals.funded.advances).toBe(sum((r) => r.factoringAdvance?.toNumber() ?? 0));
    expect(totals.funded.fees).toBe(sum((r) => r.factoringFee?.toNumber() ?? 0));
    expect(totals.reserveHeld).toBe(sum((r) => (r.factoringStatus === "funded" ? (r.factoringReserve?.toNumber() ?? 0) : 0)));
    expect(totals.reserveReleased).toBe(sum((r) => r.factoringReserveReleased?.toNumber() ?? 0));
    expect(totals.chargebacks).toEqual({ count: 1, amount: sum((r) => r.factoringChargeback?.toNumber() ?? 0) });
    expect(totals.paidByCustomers).toBe(sum((r) => r.payments.filter((p) => p.source !== "credit").reduce((s, p) => s + p.amount.toNumber(), 0)));
    // A: 900 advanced, fee 25, 75 released; B: 850 advanced, fee 25 (from the terms); D: 900 advanced and charged back (a chargeback clears its fee and reserve).
    expect(totals).toMatchObject({ withFactor: { count: 0, total: 0 }, funded: { count: 3, advances: 2650, fees: 50 }, reserveHeld: 150, reserveReleased: 75, netFromFactor: 1825 });
  });
});

describe.skipIf(!run)("a factor's status file: bad funded amounts and part payments", () => {
  const W2 = "fstatus2";
  const inv: Record<string, { id: string; loadId: string }> = {};
  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W2 } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W2 } } }, { driver: { workspace: { id: W2 } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W2 } });
    await prisma.workspace.create({ data: { id: W2, name: "Status desk 2", plan: "enterprise" } });
    expect(await saveFactoringTerms(BLANK, "test", NOW, W2)).toMatchObject({ ok: true });
    for (const n of ["F", "G", "H"]) {
      const l = await prisma.load.create({ data: { workspaceId: W2, loadNumber: `S2-${n}`, brokerName: "Acme Logistics", status: "completed", completedAt: NOW, quotedRevenue: 1000, podNote: "Signed" } as never });
      expect(await invoiceLoad(l.id, { form: { number: `INV2-${n}`, terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, NOW, W2)).toMatchObject({ ok: true });
      const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W2, number: `INV2-${n}` } });
      inv[n] = { id: rec.id, loadId: l.id };
      await prisma.invoice.update({ where: { id: rec.id }, data: { factoringStatus: "submitted" } });
      await prisma.load.update({ where: { id: l.id }, data: { factoringStatus: "submitted" } });
    }
  });
  afterAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W2 } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W2 } } }, { driver: { workspace: { id: W2 } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W2 } });
  });

  test("a funded line for zero, or for more than the invoice, is refused in the check and in apply, and the invoice is untouched", async () => {
    const file = "Invoice,Status,Amount\nINV2-F,Funded,0\nINV2-G,Funded,5000.00\n";
    for (const apply of [false, true]) {
      const out = await importFactorStatus(file, { apply }, NOW, W2);
      expect(out.ok && out.rows.map((r) => [r.invoice, r.action, r.detail])).toEqual([
        ["INV2-F", "error", "The amount funded has to be above zero and no more than the invoice."],
        ["INV2-G", "error", "The amount funded has to be above zero and no more than the invoice."]
      ]);
    }
    for (const n of ["F", "G"]) {
      const r = await prisma.invoice.findUniqueOrThrow({ where: { id: inv[n]!.id } });
      expect([r.factoringStatus, r.factoringAdvance, r.factoringFee, r.factoringReserve]).toEqual(["submitted", null, null, null]);
    }
  });

  test("two part payments in one file add up: the second closes the invoice, both are the factor's, and the same file again is already so", async () => {
    const file = "Invoice,Status,Amount\nINV2-H,Funded,\nINV2-H,Paid,600\nINV2-H,Paid,400\n";
    const check = await importFactorStatus(file, { apply: false }, NOW, W2);
    expect(check.ok && check.rows.map((r) => r.action)).toEqual(["apply", "apply", "apply"]);
    expect(check.ok && check.rows[1]!.detail).toBe("Paid $600.00 of $1000.00; the rest stays owed.");
    expect(check.ok && check.rows[2]!.detail).toMatch(/^Paid in full \(\$400\.00\); the invoice closes/);
    const out = await importFactorStatus(file, { apply: true }, NOW, W2);
    expect(out.ok && out.counts).toEqual({ apply: 3, already: 0, error: 0 });
    const h = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.H!.id }, include: { payments: { orderBy: { amount: "desc" } } } });
    expect([h.status, h.factoringStatus, h.paidTotal.toNumber(), h.factoringReserveReleased?.toNumber()]).toEqual(["paid", "paid", 1000, 75]);
    expect(h.payments.map((p) => [p.source, p.amount.toNumber()])).toEqual([["factor", 600], ["factor", 400]]);
    const again = await importFactorStatus(file, { apply: true }, NOW, W2);
    expect(again.ok && again.rows.map((r) => r.action)).toEqual(["already", "already", "already"]);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.H!.id } })).toBe(2);
  });
});
