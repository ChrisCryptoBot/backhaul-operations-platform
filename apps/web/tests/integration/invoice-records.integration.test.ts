import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { invoiceLoad, invoiceLoads, issueCreditMemo, markLoadPaid, undoPaid, voidCreditMemo, voidInvoice } from "@/server/tl/invoicing";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { ensureInvoiceRecords, openInvoiceOf, projectionOf } from "@/server/tl/invoice-records";
import { billedOf } from "@/lib/billed";

/**
 * Invoices as their own records (docs/MONEY_PLAN.md, Wave 1). Every money write keeps the record and the load's projected invoice fields equal, in one transaction;
 * this walks an invoice through its whole life and checks the two after every step, then checks the same across every workspace on the demo database.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ir-w";
const NOW = new Date("2026-11-20T18:00:00Z");

async function parity(loadId: string) {
  const l = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
  const rec = await openInvoiceOf(prisma as never, W, loadId);
  if (!rec) {
    expect(l.invoiceNumber).toBeNull();
    expect(l.paymentStatus).toBeNull();
    return null;
  }
  const [p] = (await projectionOf(prisma, rec.id)).filter((x) => x.loadId === loadId);
  expect(l.invoiceNumber).toBe(p!.invoiceNumber);
  expect(l.invoicedAmount == null ? null : l.invoicedAmount.toNumber()).toBe(p!.invoicedAmount);
  expect(l.paidAmount == null || l.paidAmount.toNumber() === 0 ? null : l.paidAmount.toNumber()).toBe(p!.paidAmount);
  expect(l.paymentStatus).toBe(p!.paymentStatus);
  expect(l.factoringStatus).toBe(rec.factoringStatus);
  return rec;
}

describe.skipIf(!run)("invoice records stay equal to the load, step by step", () => {
  let loadId = "";
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "IR desk", plan: "enterprise" } });
    const l = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "IR-1", brokerName: "IR Customer", brokerEmail: "ap@ir.invalid", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, status: "completed", completedAt: new Date(NOW.getTime() - 86_400_000), quotedRevenue: 1500, fuelSurcharge: 120, podNote: "Signed by J. Doe" } as never
    });
    loadId = l.id;
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("invoicing makes one record with typed lines, equal to the load", async () => {
    const out = await invoiceLoad(loadId, { form: { number: "IR-INV-1", terms: "30", detention: false, lumper: "75", layover: "", otherLabel: "", other: "" } }, NOW, W);
    expect(out).toMatchObject({ ok: true, total: 1695 });
    const rec = await parity(loadId);
    expect(rec!.lines.map((x) => x.kind)).toEqual(["linehaul", "fuel_surcharge", "lumper"]);
    expect(rec!.total.toNumber()).toBe(1695);
    expect(rec!.billToEmail).toBe("ap@ir.invalid");
  });

  test("a part payment with a check number keeps it open and records the reference", async () => {
    expect(await markLoadPaid(loadId, NOW, { amount: 500, method: "check", reference: "CHK 10442", payer: "IR Customer" }, W)).toMatchObject({ ok: true, balance: 1195 });
    const rec = await parity(loadId);
    expect(rec!.status).toBe("open");
    const pay = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: rec!.id } });
    expect(pay).toMatchObject({ reference: "CHK 10442", payer: "IR Customer", method: "check", source: "desk" });
  });

  test("closing short with a code keeps the code and the reason", async () => {
    expect(await markLoadPaid(loadId, NOW, { amount: 1100, shortAction: "writeoff", shortReason: "Quick-pay fee taken", shortCode: "quick_pay_fee" }, W)).toMatchObject({ ok: true });
    const rec = await parity(loadId);
    expect(rec).toMatchObject({ status: "paid", writeOffCode: "quick_pay_fee", writeOffReason: "Quick-pay fee taken" });
    expect(rec!.writeOffAmount!.toNumber()).toBe(95);
  });

  test("taking the last payment back reopens both, without the write-off", async () => {
    expect(await undoPaid(loadId, "Entered on the wrong invoice", NOW, W)).toMatchObject({ ok: true });
    const rec = await parity(loadId);
    expect(rec).toMatchObject({ status: "open", writeOffAmount: null, writeOffCode: null });
    expect(rec!.paidTotal.toNumber()).toBe(500);
    expect(await undoPaid(loadId, "Bounced", NOW, W)).toMatchObject({ ok: true });
    await parity(loadId);
  });

  test("a factor's steps follow on the record", async () => {
    await prisma.load.update({ where: { id: loadId }, data: { factoringStatus: "requested", factoringUpdatedAt: NOW } });
    const rec = await openInvoiceOf(prisma as never, W, loadId);
    await prisma.invoice.update({ where: { id: rec!.id }, data: { factoringStatus: "requested" } });
    expect(await applyFactoringUpdate(loadId, "funded", "TP-1", NOW, W)).toBe(true);
    expect((await parity(loadId))!.factoringStatus).toBe("funded");
    await prisma.load.update({ where: { id: loadId }, data: { factoringStatus: "none" } });
    await prisma.invoice.update({ where: { id: rec!.id }, data: { factoringStatus: "none" } });
  });

  test("taking the invoice back voids the record and keeps its number used", async () => {
    expect(await voidInvoice(loadId, "Wrong customer", NOW, W)).toMatchObject({ ok: true });
    expect(await parity(loadId)).toBeNull();
    const voided = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "IR-INV-1" } });
    expect(voided).toMatchObject({ status: "void", voidReason: "Wrong customer" });
    expect(await invoiceLoad(loadId, { form: { number: "IR-INV-1-2", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, NOW, W)).toMatchObject({ ok: true });
    expect((await parity(loadId))!.number).toBe("IR-INV-1-2");
  });

  test("a partial credit memo lowers what is owed, keeps the invoice open and leaves the billed amount alone (rule F)", async () => {
    const before = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    const out = await issueCreditMemo(loadId, { amount: 200, reason: "Agreed rate reduction for a late delivery", label: "Late delivery credit" }, NOW, W);
    expect(out).toMatchObject({ ok: true, number: "IR-INV-1-2-CR1", closed: false });
    const after = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    expect(after.invoicedAmount!.toNumber()).toBe(before.invoicedAmount!.toNumber());
    expect(after.paidAmount!.toNumber()).toBe(200);
    expect(after.paymentStatus).toBe("invoiced");
    const rec = await parity(loadId);
    expect(rec!.status).toBe("open");
    const memo = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "IR-INV-1-2-CR1" }, include: { lines: true } });
    expect(memo).toMatchObject({ kind: "credit_memo", status: "paid", creditOfId: rec!.id });
    expect(memo.total.toNumber()).toBe(-200);
    expect(memo.lines.map((l) => l.kind)).toEqual(["credit"]);
  });

  test("a credit is not undone as a payment; voiding the memo puts the balance back", async () => {
    expect(await undoPaid(loadId, "Try to undo the credit", NOW, W)).toMatchObject({ ok: false });
    const memo = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "IR-INV-1-2-CR1" } });
    expect(await voidCreditMemo(memo.id, "Customer withdrew the claim", NOW, W)).toMatchObject({ ok: true });
    const l = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    expect(l.paidAmount).toBeNull();
    await parity(loadId);
  });

  test("a credit cannot exceed what is owed, and a credit of all of it closes the invoice", async () => {
    const l = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    const owed = l.invoicedAmount!.toNumber();
    expect(await issueCreditMemo(loadId, { amount: owed + 1, reason: "Too much" }, NOW, W)).toMatchObject({ ok: false });
    expect(await issueCreditMemo(loadId, { amount: owed, reason: "Load cancelled after billing, customer credited in full" }, NOW, W)).toMatchObject({ ok: true, closed: true });
    const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "IR-INV-1-2" } });
    expect(rec.status).toBe("paid");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).paymentStatus).toBe("paid");
  });

  test("bulk-written invoices get their records, once", async () => {
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "IR-2", brokerName: "IR Customer", status: "completed", quotedRevenue: 900, paymentStatus: "paid", invoiceNumber: "IR-BULK-2", invoicedAt: NOW, invoicedAmount: 900, paidAt: NOW, paidAmount: 900 } as never });
    expect(await ensureInvoiceRecords(prisma, W)).toBe(1);
    expect(await ensureInvoiceRecords(prisma, W)).toBe(0);
    const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "IR-BULK-2" }, include: { payments: true } });
    expect(rec.status).toBe("paid");
    expect(rec.payments.map((p) => p.amount.toNumber())).toEqual([900]);
  });
});

describe.skipIf(!run)("one invoice for several loads of the same customer (rules A and G)", () => {
  const WM = "ir-multi";
  const ids: string[] = [];
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: WM } });
    await prisma.workspace.create({ data: { id: WM, name: "IR multi", plan: "enterprise" } });
    for (const [n, rate, fsc, broker] of [["M-1", 1000, 100, "Acme Logistics"], ["M-2", 2000, 0, "ACME  logistics"], ["M-3", 1500, 50, "Acme Logistics"], ["M-X", 900, 0, "Other Broker"]] as const) {
      const l = await prisma.load.create({ data: { workspaceId: WM, loadNumber: n, brokerName: broker, brokerEmail: "ap@acme.invalid", status: "completed", completedAt: NOW, quotedRevenue: rate, fuelSurcharge: fsc, podNote: "Signed" } as never });
      ids.push(l.id);
    }
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: WM } });
  });

  test("loads of different customers are refused", async () => {
    expect(await invoiceLoads([ids[0]!, ids[3]!], { number: "MX-1" }, NOW, WM)).toMatchObject({ ok: false });
  });

  test("three loads, one number; each load keeps its own lines and share", async () => {
    expect(await invoiceLoads([ids[0]!, ids[1]!, ids[2]!], { number: "ACME-100", terms: "30" }, NOW, WM)).toMatchObject({ ok: true, number: "ACME-100", total: 4650 });
    const loads = await prisma.load.findMany({ where: { id: { in: ids.slice(0, 3) } }, orderBy: { loadNumber: "asc" } });
    expect(loads.map((l) => [l.invoiceNumber, l.invoicedAmount!.toNumber(), l.paymentStatus])).toEqual([["ACME-100", 1100, "invoiced"], ["ACME-100", 2000, "invoiced"], ["ACME-100", 1550, "invoiced"]]);
    const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: WM, number: "ACME-100" }, include: { loads: true, lines: true } });
    expect(rec.loads).toHaveLength(3);
    expect(rec.total.toNumber()).toBe(4650);
    expect(await invoiceLoad(ids[0]!, {}, NOW, WM)).toMatchObject({ ok: false });
  });

  test("a payment entered on any of its loads pays the invoice, shared first load first", async () => {
    expect(await markLoadPaid(ids[1]!, NOW, { amount: 2000, reference: "ACH 7781" }, WM)).toMatchObject({ ok: true, balance: 2650 });
    const loads = await prisma.load.findMany({ where: { id: { in: ids.slice(0, 3) } }, orderBy: { loadNumber: "asc" } });
    expect(loads.map((l) => l.paidAmount?.toNumber() ?? null)).toEqual([1100, 900, null]);
    expect(await undoPaid(ids[0]!, "Wrong one", NOW, WM)).toMatchObject({ ok: false });
    expect(await markLoadPaid(ids[2]!, NOW, { amount: 2650 }, WM)).toMatchObject({ ok: true });
    const paid = await prisma.load.findMany({ where: { id: { in: ids.slice(0, 3) } }, orderBy: { loadNumber: "asc" } });
    expect(paid.map((l) => [l.paymentStatus, l.paidAmount!.toNumber()])).toEqual([["paid", 1100], ["paid", 2000], ["paid", 1550]]);
  });

  test("an unpaid invoice of several loads is taken back whole", async () => {
    expect(await invoiceLoads([ids[0]!, ids[3]!].slice(0, 1).concat([]), {}, NOW, WM)).toMatchObject({ ok: false });
    await prisma.load.create({ data: { workspaceId: WM, loadNumber: "M-4", brokerName: "Acme Logistics", status: "completed", completedAt: NOW, quotedRevenue: 700, podNote: "Signed" } as never }).then((l) => ids.push(l.id));
    await prisma.load.create({ data: { workspaceId: WM, loadNumber: "M-5", brokerName: "Acme Logistics", status: "completed", completedAt: NOW, quotedRevenue: 800, podNote: "Signed" } as never }).then((l) => ids.push(l.id));
    expect(await invoiceLoads([ids[4]!, ids[5]!], { number: "ACME-101" }, NOW, WM)).toMatchObject({ ok: true });
    expect(await voidInvoice(ids[5]!, "Customer wants them separate", NOW, WM)).toMatchObject({ ok: true });
    const back = await prisma.load.findMany({ where: { id: { in: [ids[4]!, ids[5]!] } } });
    expect(back.every((l) => l.paymentStatus === null && l.invoiceNumber === null)).toBe(true);
    expect((await prisma.invoice.findFirstOrThrow({ where: { workspaceId: WM, number: "ACME-101" } })).status).toBe("void");
  });
});

describe.skipIf(!run)("every invoiced load on the database has a record that agrees with it", () => {
  test("projection parity across all workspaces, in one query", async () => {
    // One-load invoices: number, amount (billedOf's rule for an invoice from before amounts were kept), what came in and the state must all match the load.
    // An invoice of several loads shares what came in across them (rule A), which this query does not re-derive; its loads are checked for number, amount and state.
    const rows = await prisma.$queryRaw<Array<{ missing: number; mismatched: number; checked: number; sample: string | null }>>`
      WITH l AS (
        SELECT l.id, l.workspace_id, l.invoice_number, l.payment_status,
          ROUND(COALESCE(l.invoiced_amount, CASE WHEN l.status = 'tonu' THEN COALESCE(l.tonu_revenue, 0) ELSE l.quoted_revenue + COALESCE(l.fuel_surcharge, 0) END), 2) AS billed,
          ROUND(COALESCE(l.paid_amount, 0), 2) AS paid
        FROM loads l WHERE l.invoice_number IS NOT NULL AND l.payment_status IN ('invoiced', 'paid')
      ), r AS (
        SELECT DISTINCT ON (il.load_id) il.load_id, i.id AS invoice_id, i.number, i.status, i.paid_total,
          (SELECT COUNT(*) FROM invoice_loads x WHERE x.invoice_id = i.id) AS n_loads,
          (SELECT COALESCE(SUM(amount), 0) FROM invoice_lines y WHERE y.invoice_id = i.id AND y.load_id = il.load_id) AS load_amount
        FROM invoice_loads il JOIN invoices i ON i.id = il.invoice_id AND i.status <> 'void'
        ORDER BY il.load_id, i.issued_at DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE r.invoice_id IS NULL)::int AS missing,
        COUNT(*) FILTER (WHERE r.invoice_id IS NOT NULL AND (
          r.number <> l.invoice_number OR r.load_amount <> l.billed
          OR (CASE r.status WHEN 'paid' THEN 'paid' ELSE 'invoiced' END) <> l.payment_status
          OR (r.n_loads = 1 AND r.paid_total <> l.paid)))::int AS mismatched,
        COUNT(*)::int AS checked,
        MIN(CASE WHEN r.invoice_id IS NULL OR r.number <> l.invoice_number OR r.load_amount <> l.billed OR (r.n_loads = 1 AND r.paid_total <> l.paid) THEN l.id END) AS sample
      FROM l LEFT JOIN r ON r.load_id = l.id`;
    const [res] = rows;
    expect(res!.checked).toBeGreaterThan(0);
    expect({ missing: res!.missing, mismatched: res!.mismatched, sample: res!.sample }).toEqual({ missing: 0, mismatched: 0, sample: null });
  });
});
