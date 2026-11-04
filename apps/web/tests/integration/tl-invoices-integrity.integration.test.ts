import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { sendToPayroll } from "@/server/partners/payroll";
import { saveBillingDetails } from "@/server/tl/billing-details";
import { invoiceLoad, markLoadPaid, suggestedInvoiceNumber, undoPaid, voidInvoice } from "@/server/tl/invoicing";
import { saveExpenses } from "@/server/tl/execution";
import { discardSettlement, finalizeSettlement, markSettlementPaid, saveDraft, startSettlement, voidSettlement } from "@/server/tl/settlement";

/**
 * Invoices and driver statements, the moves that must happen once and in order: a statement that is finalized cannot be deleted or overwritten by a slower click, a statement the driver
 * was paid on cannot be voided or paid again, an invoice taken back leaves nothing behind and comes back under a new number, and the factoring status never strands. A workspace of
 * its own, so the figures and numbers are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ii-w";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

/** Statements restrict their driver, so they go before the workspace does. */
async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("invoices and statements on the demo database", () => {
  let driverId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "II desk", plan: "enterprise" } });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "II Driver", payrollWorkerType: "contractor", payrollEmployeeId: "E-1" } })).id;
  });
  afterAll(wipe);

  /** A delivered load with a driver paid per mile, on its own day. */
  async function delivered(key: string, date: string, over: Record<string, unknown> = {}) {
    const l = await prisma.load.create({
      data: {
        workspaceId: W, loadNumber: `II-${key}`, brokerName: "II Customer", brokerEmail: "ap@ii.test", status: "completed", completedAt: day(date), quotedRevenue: 1000, loadedMiles: 200, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK",
        assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } },
        ...over
      } as never
    });
    ids[key] = l.id;
    return l;
  }
  const invoice = (key: string, number: string) => invoiceLoad(ids[key]!, { form: { number, terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, new Date(), W);
  const row = (key: string) => prisma.load.findUniqueOrThrow({ where: { id: ids[key]! } });

  describe("driver statements", () => {
    test("a draft is numbered from a counter, so a discarded number is never given again", async () => {
      await delivered("S1", "2026-09-02");
      const a = await startSettlement({ driverId, start: "2026-09-01", end: "2026-09-07" }, new Date(), W);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      const first = (await prisma.settlement.findUniqueOrThrow({ where: { id: a.id } })).number;
      // A second draft over the same dates is refused, naming the first.
      expect(await startSettlement({ driverId, start: "2026-09-01", end: "2026-09-07" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining(`${first} is already a draft`) });
      expect(await discardSettlement(a.id, new Date(), W)).toMatchObject({ ok: true });
      const b = await startSettlement({ driverId, start: "2026-09-01", end: "2026-09-07" }, new Date(), W);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      const second = (await prisma.settlement.findUniqueOrThrow({ where: { id: b.id } })).number;
      expect(second).not.toBe(first);
      ids.draftS1 = b.id;
    });

    test("a finalize and a discard sent together leave one answer: a final statement with its loads, never a deleted one", async () => {
      const id = ids.draftS1!;
      const out = await Promise.all([finalizeSettlement(id, { hours: {}, adjustments: [] }, new Date(), W), discardSettlement(id, new Date(), W)]);
      expect(out.filter((r) => r.ok)).toHaveLength(1);
      const s = await prisma.settlement.findUnique({ where: { id }, include: { loads: true } });
      if (s) expect([s.status, s.loads.length]).toEqual(["final", 1]);
      else expect(await prisma.settlementLoad.count({ where: { loadId: ids.S1! } })).toBe(0); // discarded first: nothing left half-done
    });

    test("typing into a statement that was just finalized overwrites nothing", async () => {
      await delivered("S2", "2026-09-10");
      const a = await startSettlement({ driverId, start: "2026-09-08", end: "2026-09-14" }, new Date(), W);
      if (!a.ok) throw new Error("setup");
      expect(await finalizeSettlement(a.id, { hours: {}, adjustments: [{ label: "Advance", amount: "-20" }] }, new Date(), W)).toMatchObject({ ok: true });
      const before = await prisma.settlement.findUniqueOrThrow({ where: { id: a.id } });
      expect(await saveDraft(a.id, { hours: {}, adjustments: [{ label: "Bonus", amount: "500" }] }, W)).toMatchObject({ ok: false });
      const after = await prisma.settlement.findUniqueOrThrow({ where: { id: a.id } });
      expect([after.adjustments, after.total]).toEqual([before.adjustments, before.total]);
      ids.finalS2 = a.id;
    });

    test("the total the person confirmed has to still be the total, or nothing is frozen", async () => {
      await delivered("S3", "2026-09-17");
      const a = await startSettlement({ driverId, start: "2026-09-15", end: "2026-09-21" }, new Date(), W);
      if (!a.ok) throw new Error("setup");
      expect(await finalizeSettlement(a.id, { hours: {}, adjustments: [] }, new Date(), W, 150)).toMatchObject({ ok: false, error: expect.stringContaining("you were looking at") });
      expect((await prisma.settlement.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("draft");
      expect(await finalizeSettlement(a.id, { hours: {}, adjustments: [] }, new Date(), W, 100)).toMatchObject({ ok: true });
      expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "load_settled", loadId: ids.S3! } })).toBe(1);
      ids.finalS3 = a.id;
    });

    test("a statement the driver was paid on, by check or payroll, cannot be voided or paid again", async () => {
      expect(await markSettlementPaid(ids.finalS2!, { paidOn: "2026-09-20", method: "bitcoin" }, new Date(), W)).toMatchObject({ ok: false });
      expect(await markSettlementPaid(ids.finalS2!, { paidOn: "2027-12-01", method: "check" }, new Date(), W)).toMatchObject({ ok: false });
      expect(await markSettlementPaid(ids.finalS2!, { paidOn: "2026-09-20", method: "check" }, new Date(), W)).toMatchObject({ ok: true });
      expect(await markSettlementPaid(ids.finalS2!, { paidOn: "2026-09-20", method: "check" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("already marked paid") });
      expect(await voidSettlement(ids.finalS2!, "wrong week", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("marked paid") });
      // It cannot then go to payroll too: that would pay the driver twice.
      expect(await sendToPayroll([ids.finalS2!], new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("marked paid") });
      // A statement already sent to payroll cannot be marked paid by hand.
      await prisma.settlement.update({ where: { id: ids.finalS3! }, data: { payrollSentAt: new Date(), payrollReference: "PAY-1" } });
      expect(await markSettlementPaid(ids.finalS3!, { paidOn: "2026-09-20", method: "check" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("payroll") });
    });

    test("a statement that comes to nothing, or less, is not sent to payroll", async () => {
      await delivered("S4", "2026-09-24");
      const a = await startSettlement({ driverId, start: "2026-09-22", end: "2026-09-28" }, new Date(), W);
      if (!a.ok) throw new Error("setup");
      expect(await finalizeSettlement(a.id, { hours: {}, adjustments: [{ label: "Advance", amount: "-400" }] }, new Date(), W)).toMatchObject({ ok: true });
      expect(Number((await prisma.settlement.findUniqueOrThrow({ where: { id: a.id } })).total)).toBe(-300);
      expect(await sendToPayroll([a.id], new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("owes money") });
    });

    test("a load on a final statement keeps the loaded miles it was paid on", async () => {
      const out = await saveExpenses(ids.S3!, { fuel: "", tolls: "", misc: "", miles: { pickup: "", loaded: "250", home: "" } }, new Date(), W);
      expect(out).toMatchObject({ ok: false, error: expect.stringContaining("loaded miles are what the driver was paid on") });
      expect(Number((await row("S3")).loadedMiles)).toBe(200);
      // The other figures do not change the pay, so they can still be corrected.
      expect(await saveExpenses(ids.S3!, { fuel: "10", tolls: "", misc: "" }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    });
  });

  describe("invoices", () => {
    test("an invoice taken back leaves the load's own terms, and comes back under the next revision of its number", async () => {
      await delivered("I1", "2026-10-01");
      expect(await suggestedInvoiceNumber({ id: ids.I1!, loadNumber: "II-I1" }, W)).toBe("INV-II-I1");
      expect(await invoice("I1", "INV-II-I1")).toMatchObject({ ok: true });
      expect((await row("I1")).payTermsDays).toBe(30);
      expect(await voidInvoice(ids.I1!, "wrong amount", new Date(), W)).toEqual({ ok: true });
      const back = await row("I1");
      expect([back.paymentStatus, back.invoiceNumber, back.payTermsDays]).toEqual([null, null, null]);
      expect(await suggestedInvoiceNumber({ id: ids.I1!, loadNumber: "II-I1" }, W)).toBe("INV-II-I1-2");
      expect(await invoice("I1", "INV-II-I1-2")).toMatchObject({ ok: true });
      expect(await voidInvoice(ids.I1!, "wrong again", new Date(), W)).toEqual({ ok: true });
      expect(await suggestedInvoiceNumber({ id: ids.I1!, loadNumber: "II-I1" }, W)).toBe("INV-II-I1-3");
    });

    test("a load that already has terms keeps them through an invoice that is taken back", async () => {
      await delivered("I2", "2026-10-02", { payTermsDays: 45 });
      expect(await invoice("I2", "INV-II-I2")).toMatchObject({ ok: true });
      expect(await voidInvoice(ids.I2!, "wrong customer", new Date(), W)).toEqual({ ok: true });
      expect((await row("I2")).payTermsDays).toBe(45);
    });

    test("every refusal says why, and not-found is a message, not a crash", async () => {
      expect(await invoiceLoad("nope", {}, new Date(), W)).toMatchObject({ ok: false, error: "That load does not exist." });
      await delivered("I5", "2026-10-07");
      expect(await invoice("I5", "INV-II-I5")).toMatchObject({ ok: true });
      expect(await invoice("I5", "INV-II-I5-9")).toMatchObject({ ok: false, error: expect.stringContaining("already invoiced") });
      expect(await markLoadPaid("nope", new Date(), {}, W)).toMatchObject({ ok: false, error: "That load does not exist." });
      await delivered("I3", "2026-10-03");
      expect(await markLoadPaid(ids.I3!, new Date(), {}, W)).toMatchObject({ ok: false, error: expect.stringContaining("no invoice") });
      expect(await voidInvoice("nope", "reason here", new Date(), W)).toMatchObject({ ok: false, error: "That load does not exist." });
      expect(await undoPaid("nope", "reason here", new Date(), W)).toMatchObject({ ok: false, error: "That load does not exist." });
    });

    test("a payment and a void sent together leave a consistent invoice: never ready to invoice with money received", async () => {
      await delivered("I4", "2026-10-04");
      expect(await invoice("I4", "INV-II-I4")).toMatchObject({ ok: true });
      await Promise.all([voidInvoice(ids.I4!, "wrong amount", new Date(), W), markLoadPaid(ids.I4!, new Date(), { amount: 400 }, W)]);
      const l = await row("I4");
      const rows = await prisma.loadPayment.count({ where: { loadId: ids.I4! } });
      if (l.paymentStatus === null) expect([rows, l.paidAmount]).toEqual([0, null]);
      else expect(rows).toBe(1);
    });

    test("undoing a payment on a factored invoice moves factoring back, and a customer paying in full closes it", async () => {
      await delivered("F1", "2026-10-05");
      expect(await invoice("F1", "INV-II-F1")).toMatchObject({ ok: true });
      await prisma.load.update({ where: { id: ids.F1! }, data: { factoringStatus: "requested", factoringReferenceId: "R1" } });
      expect(await markLoadPaid(ids.F1!, new Date(), {}, W)).toMatchObject({ ok: true });
      expect((await row("F1")).factoringStatus).toBe("paid");
      // The factor has nothing left to answer on a paid invoice.
      expect(await applyFactoringUpdate(ids.F1!, "funded", null, new Date(), W)).toBe(false);
      expect(await undoPaid(ids.F1!, "bounced", new Date(), W)).toEqual({ ok: true });
      expect((await row("F1")).factoringStatus).toBe("funded");
      expect(await applyFactoringUpdate(ids.F1!, "paid", null, new Date(), W)).toBe(true);
    });

    test("a request the factor rejected is as if it was never made: the invoice can be taken back", async () => {
      await delivered("F2", "2026-10-06");
      expect(await invoice("F2", "INV-II-F2")).toMatchObject({ ok: true });
      await prisma.load.update({ where: { id: ids.F2! }, data: { factoringStatus: "rejected", factoringReferenceId: "R2" } });
      expect(await voidInvoice(ids.F2!, "wrong amount", new Date(), W)).toEqual({ ok: true });
      expect(await row("F2")).toMatchObject({ factoringStatus: "none", factoringReferenceId: null, paymentStatus: null });
      // One that has really gone to the factor cannot be.
      expect(await invoice("F2", "INV-II-F2-2")).toMatchObject({ ok: true });
      await prisma.load.update({ where: { id: ids.F2! }, data: { factoringStatus: "funded" } });
      expect(await voidInvoice(ids.F2!, "wrong amount", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("factoring") });
    });
  });

  describe("billing details", () => {
    test("the billing office changes the customer, contact, PO and terms, once, and says what changed", async () => {
      await delivered("B1", "2026-10-08");
      const values = { brokerName: "II Customer Co", brokerMcNumber: "MC 123456", brokerPhone: "555-0100", brokerEmail: "AP@II.TEST", poNumber: "PO-9", payTermsDays: "45", revenueNote: "Short pay agreed" };
      expect(await saveBillingDetails(ids.B1!, { ...values, brokerName: "" }, new Date(), W)).toMatchObject({ ok: false, errors: { brokerName: expect.any(String) } });
      expect(await saveBillingDetails(ids.B1!, values, new Date(), W)).toEqual({ ok: true, changed: true });
      expect(await row("B1")).toMatchObject({ brokerName: "II Customer Co", brokerMcNumber: "123456", brokerEmail: "ap@ii.test", poNumber: "PO-9", payTermsDays: 45, revenueNote: "Short pay agreed" });
      expect(await saveBillingDetails(ids.B1!, values, new Date(), W)).toEqual({ ok: true, changed: false });
      const e = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: ids.B1!, action: "load_edited" } });
      expect(e.summary).toContain("customer");
    });

    test("once invoiced, the customer, PO and terms are what the invoice carries; the contact and the note can still be corrected", async () => {
      expect(await invoice("B1", "INV-II-B1")).toMatchObject({ ok: true });
      // The invoice set the load's terms to the 30 days it was made on.
      const values = { brokerName: "II Customer Co", brokerMcNumber: "123456", brokerPhone: "555-0100", brokerEmail: "ap@ii.test", poNumber: "PO-9", payTermsDays: "30", revenueNote: "Short pay agreed" };
      expect(await saveBillingDetails(ids.B1!, { ...values, brokerName: "Someone else" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("invoiced") });
      expect(await saveBillingDetails(ids.B1!, { ...values, poNumber: "PO-10" }, new Date(), W)).toMatchObject({ ok: false });
      expect(await saveBillingDetails(ids.B1!, { ...values, brokerEmail: "billing@ii.test", revenueNote: "Agreed by phone" }, new Date(), W)).toEqual({ ok: true, changed: true });
      expect(await saveBillingDetails("nope", values, new Date(), W)).toMatchObject({ ok: false, error: "That load does not exist." });
    });
  });
});
