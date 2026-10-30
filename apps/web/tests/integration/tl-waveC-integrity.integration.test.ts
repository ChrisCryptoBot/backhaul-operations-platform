import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/disruptions";
import { toEditValues, type LoadEditValues } from "@/lib/load-edit";
import { statesAgree } from "@/lib/load-state";

/**
 * Part C of the audit plan, on the demo database in a workspace of its own: the two statuses of a load that must always agree, a TONU that can be invoiced, a rate confirmation
 * that cannot take another desk's truck, money that cannot be sent or paid twice, a statement that cannot be voided after payroll, a short payment that has to be explained, an
 * invoice that can be taken back, and a factoring packet made only of files that are kept.
 */
const W = "partc";
vi.mock("@/server/tl/workspace", async (original) => {
  const real = await original<typeof import("@/server/tl/workspace")>();
  const { prisma: db } = await import("@/lib/db");
  return { ...real, currentWorkspaceId: () => "partc", currentWorkspace: () => db.workspace.findUniqueOrThrow({ where: { id: "partc" } }) };
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const KEYS = ["TRIUMPHPAY_API_KEY", "GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"];

describe.skipIf(!run)("Part C: integrity of loads, money and documents", () => {
  const uploads = mkdtempSync(path.join(tmpdir(), "partc-"));
  let driver1 = "";
  let driver2 = "";
  let seq = 0;

  const events = (loadId: string) => prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "asc" } });
  const stops = (offset: number) => ({
    create: [
      { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: day(offset), timeWindowLatest: day(offset) },
      { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: day(offset + 1), timeWindowLatest: day(offset + 1) }
    ]
  });
  const mkLoad = (over: Record<string, unknown> = {}, offset = 20) => {
    seq += 1;
    return prisma.load.create({
      data: { workspaceId: W, loadNumber: `C-${seq}`, status: "draft", brokerName: "C Broker", brokerEmail: "ap@c.example", quotedRevenue: 1000, fuelSurcharge: 0, loadedMiles: 200, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", scheduledDate: day(offset), stops: stops(offset), ...over },
      include: { stops: true }
    });
  };
  const agree = async (id: string) => {
    const l = await prisma.load.findUniqueOrThrow({ where: { id }, include: { assignment: true } });
    expect(statesAgree(l.status, l.assignment?.status ?? null), `load ${l.status} / assignment ${l.assignment?.status ?? "none"}`).toBe(true);
    return l;
  };
  const pay = { kind: "cpm" as const, rate: 0.6 };

  beforeAll(async () => {
    process.env.DESK_UPLOAD_DIR = uploads;
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Part C desk", plan: "enterprise" } });
    const ok = { cdlExpiry: day(900), medicalCardExpiry: day(900) };
    driver1 = (await prisma.driver.create({ data: { workspaceId: W, name: "C Driver One", ...ok, payrollWorkerType: "employee", payrollEmployeeId: "emp-1" } })).id;
    driver2 = (await prisma.driver.create({ data: { workspaceId: W, name: "C Driver Two", ...ok } })).id;
  });
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterAll(async () => {
    delete process.env.DESK_UPLOAD_DIR;
    for (const k of KEYS) delete process.env[k];
    await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: W } } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    rmSync(uploads, { recursive: true, force: true });
  });

  // ── C1: the two statuses agree ──────────────────────────────────────────────────────────────

  test("a load's status and its assignment's go together through assign, send, accept, reassign, decline, reschedule and unassign", async () => {
    const { assignDriver, dispatchLoad, recordDriverResponse, unassignLoad } = await import("@/server/tl/dispatch");
    const { rescheduleLoad } = await import("@/server/tl/disruptions");
    const l = await mkLoad();
    await assignDriver({ loadId: l.id, driverId: driver1, pay }, new Date(), W);
    expect((await agree(l.id)).status).toBe("draft");
    await dispatchLoad(l.id, new Date(), {}, W);
    expect((await agree(l.id)).status).toBe("draft");
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    expect((await agree(l.id)).status).toBe("accepted");

    // A new driver on an accepted load: the load is a draft again, and shows up as needing a driver
    // swapping a driver who has accepted needs a reason
    await expect(assignDriver({ loadId: l.id, driverId: driver2, pay }, new Date(), W)).rejects.toThrow(/Add a reason/);
    await assignDriver({ loadId: l.id, driverId: driver2, pay, overrideReason: "Driver two is closer" }, new Date(), W);
    expect((await agree(l.id)).status).toBe("draft");
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "declined", new Date(), "Cannot", W);
    expect((await agree(l.id)).status).toBe("draft");

    // Accepted, then the pickup moves: the driver has to say yes again, and the load is not "accepted" meanwhile
    await assignDriver({ loadId: l.id, driverId: driver1, pay }, new Date(), W);
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    expect((await agree(l.id)).status).toBe("accepted");
    await rescheduleLoad({ loadId: l.id, newPickup: day(25), reason: RESCHEDULE_REASONS[0]!.key }, new Date(), W);
    const moved = await agree(l.id);
    expect([moved.status, moved.assignment?.status]).toEqual(["draft", "dispatched"]);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    expect((await agree(l.id)).status).toBe("accepted");

    await unassignLoad(l.id, "Driver is sick", new Date(), W);
    const bare = await agree(l.id);
    expect([bare.status, bare.assignment]).toEqual(["draft", null]);
  });

  test("changing what a driver is paid on an accepted load asks the driver again, and the load follows", async () => {
    const { assignDriver, dispatchLoad, recordDriverResponse } = await import("@/server/tl/dispatch");
    const { saveLoadDetails } = await import("@/server/tl/edit");
    const l = await mkLoad({ status: "draft" });
    await assignDriver({ loadId: l.id, driverId: driver1, pay }, new Date(), W);
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    const v: LoadEditValues = toEditValues(await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
    v.stops[0]!.earliest = toLocalText(day(26));
    v.stops[0]!.latest = toLocalText(day(26));
    v.stops[1]!.earliest = toLocalText(day(27));
    v.stops[1]!.latest = toLocalText(day(27));
    const out = await saveLoadDetails(l.id, v, new Date(), W);
    expect(out).toMatchObject({ ok: true, changed: true });
    const after = await agree(l.id);
    expect([after.status, after.assignment?.status]).toEqual(["draft", "dispatched"]);
  });

  // ── C2: a TONU can be invoiced ──────────────────────────────────────────────────────────────

  test("a TONU is invoiced for its fee alone, listed with the invoices, billed once and paid like any other", async () => {
    const { assignDriver, dispatchLoad, recordDriverResponse } = await import("@/server/tl/dispatch");
    const { recordTonu } = await import("@/server/tl/disruptions");
    const { invoiceLoad, markLoadPaid, getInvoice } = await import("@/server/tl/invoicing");
    const { countInvoices, listInvoiceRows } = await import("@/server/tl/queries");
    const l = await mkLoad({ fuelSurcharge: 80 });
    await assignDriver({ loadId: l.id, driverId: driver1, pay }, new Date(), W);
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    await recordTonu({ loadId: l.id, fee: 175, reason: CANCEL_REASONS[0]!.key }, new Date(), W);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("tonu");

    const ready = (await listInvoiceRows(W, { scope: "ready" })).find((r) => r.id === l.id)!;
    expect(ready).toMatchObject({ amount: 175, invoiceContext: { rate: 175, surcharge: 0, detention: 0, rateLabel: "TONU fee" } });
    expect(ready.readiness.blockers).toEqual([]);
    expect(await countInvoices("ready", W)).toBeGreaterThanOrEqual(1);

    expect(await invoiceLoad(l.id, { includeDetention: true }, new Date(), W)).toMatchObject({ ok: true, total: 175 });
    const inv = await getInvoice(l.id, W);
    expect(inv!.lines).toEqual([{ label: "TONU fee", amount: 175 }]);
    expect(inv!.total).toBe(175);
    expect(await invoiceLoad(l.id, {}, new Date(), W)).toMatchObject({ ok: false });
    expect((await listInvoiceRows(W, { scope: "out" })).some((r) => r.id === l.id)).toBe(true);
    expect(await markLoadPaid(l.id, new Date(), {}, W)).toEqual({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).paymentStatus).toBe("paid");
  });

  test("a cancelled load and a TONU with no fee cannot be invoiced", async () => {
    const { invoiceLoad } = await import("@/server/tl/invoicing");
    const cancelled = await mkLoad({ status: "cancelled" });
    const noFee = await mkLoad({ status: "tonu", tonuRevenue: 0 });
    expect(await invoiceLoad(cancelled.id, {}, new Date(), W)).toMatchObject({ ok: false });
    expect(await invoiceLoad(noFee.id, {}, new Date(), W)).toMatchObject({ ok: false });
  });

  // ── C4: another desk's truck ────────────────────────────────────────────────────────────────

  test("a rate confirmation will not take a truck from another desk, or one that is archived", async () => {
    const { saveReviewedDraft } = await import("@/server/ratecon/save");
    const { extractionToLoadDraft } = await import("@/server/ratecon/map");
    const other = await prisma.workspace.create({ data: { id: "partc-other", name: "Other", plan: "enterprise" } });
    try {
      const theirs = await prisma.vehicle.create({ data: { workspaceId: other.id, name: "Their truck", costProfile: { create: { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner" } } } });
      const mine = await prisma.vehicle.create({ data: { workspaceId: W, name: "C archived", archivedAt: new Date() } });
      const draft = extractionToLoadDraft({ loadNumber: "RC-X-1", brokerName: "C Broker", rate: 900, stops: [{ role: "pickup", address: "Dallas, TX", date: "2027-06-01", time: "08:00" }, { role: "delivery", address: "Tulsa, OK", date: "2027-06-02", time: "09:00" }] } as never, undefined);
      if (!draft) throw new Error("no draft");
      const review = { ...draft, confirmed: true, load: { ...draft.load, quotedRevenue: 900, loadedMiles: 250, loadNumber: "C-RC-1" } };
      await expect(saveReviewedDraft({ ...review, vehicleId: theirs.id })).rejects.toThrow(/not available/);
      await expect(saveReviewedDraft({ ...review, vehicleId: mine.id })).rejects.toThrow(/not available/);
      expect(await prisma.load.count({ where: { workspaceId: W, loadNumber: "C-RC-1" } })).toBe(0);
    } finally {
      await prisma.workspace.deleteMany({ where: { id: "partc-other" } });
    }
  });

  // ── C5: money ───────────────────────────────────────────────────────────────────────────────

  test("a correction to the rate of a delivered, uninvoiced load reaches the revenue the KPI reads", async () => {
    const { saveLoadDetails } = await import("@/server/tl/edit");
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "C truck", costProfile: { create: { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner" } } } });
    const l = await mkLoad({ status: "completed", completedAt: day(-1), actualRevenue: 1000, vehicleId: truck.id }, -3);
    const v = toEditValues(await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
    v.deal = { ...v.deal!, rate: "1250" };
    expect(await saveLoadDetails(l.id, v, new Date(), W)).toMatchObject({ ok: true });
    const after = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([Number(after.quotedRevenue), Number(after.actualRevenue)]).toEqual([1250, 1250]);
  });

  test("an invoice is made once however many times it is asked for, and paid once", async () => {
    const { invoiceLoad, markLoadPaid } = await import("@/server/tl/invoicing");
    const l = await mkLoad({ status: "completed", completedAt: day(-2), actualRevenue: 1000 }, -4);
    const two = await Promise.all([invoiceLoad(l.id, {}, new Date(), W), invoiceLoad(l.id, {}, new Date(), W)]);
    expect(two.filter((r) => r.ok)).toHaveLength(1);
    expect((await events(l.id)).filter((e) => e.action === "invoiced")).toHaveLength(1);
    const pays = await Promise.all([markLoadPaid(l.id, new Date(), {}, W), markLoadPaid(l.id, new Date(), {}, W)]);
    expect(pays.filter((r) => r.ok)).toHaveLength(1);
    expect((await events(l.id)).filter((e) => e.action === "paid")).toHaveLength(1);
  });

  test("closing an invoice below what is owed writes the rest off only with a reason, which is kept", async () => {
    const { invoiceLoad, markLoadPaid } = await import("@/server/tl/invoicing");
    const l = await mkLoad({ status: "completed", completedAt: day(-2), actualRevenue: 1000 }, -4);
    await invoiceLoad(l.id, {}, new Date(), W);
    const refused = await markLoadPaid(l.id, new Date(), { amount: 900, shortAction: "writeoff" }, W);
    expect(refused).toMatchObject({ ok: false, needsShortReason: true, error: expect.stringContaining("$100.00") });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).paymentStatus).toBe("invoiced");
    expect(await markLoadPaid(l.id, new Date(), { amount: 900, shortAction: "writeoff", shortReason: "x" }, W)).toMatchObject({ ok: false, needsShortReason: true });
    expect(await markLoadPaid(l.id, new Date(), { amount: 900, shortAction: "writeoff", shortReason: "Damage claim, agreed with the broker" }, W)).toEqual({ ok: true, difference: -100 });
    const paid = (await events(l.id)).find((e) => e.action === "paid")!;
    expect(paid).toMatchObject({ reason: "Damage claim, agreed with the broker", summary: expect.stringContaining("written off") });
    expect(await prisma.loadPayment.count({ where: { loadId: l.id } })).toBe(1);
  });

  test("a payment below what is owed keeps the invoice out with the balance, counted by ageing, the lists and the invoice, until it is paid or written off", async () => {
    const { invoiceLoad, markLoadPaid, undoPaid, voidInvoice, getInvoice } = await import("@/server/tl/invoicing");
    const { agingSummary } = await import("@/server/tl/aging");
    const { listInvoiceRows } = await import("@/server/tl/queries");
    const { owedOf } = await import("@/lib/invoicing");
    const l = await mkLoad({ status: "completed", completedAt: day(-40), actualRevenue: 1000, brokerName: "Partial Co" }, -42);
    await invoiceLoad(l.id, { form: { number: "PART-1", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, day(-35), W);
    const owedNow = async () => (await agingSummary(Date.now(), W)) as unknown as { overdueCount: number; totalOutstanding: number };
    const before = await owedNow();

    // 400 of 1000 comes in: still out, 600 owed, and it is still overdue (the invoice is past its terms)
    expect(await markLoadPaid(l.id, new Date(), { amount: 400, method: "ach" }, W)).toEqual({ ok: true, balance: 600 });
    let row = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([row.paymentStatus, Number(row.paidAmount), row.paidAt]).toEqual(["invoiced", 400, null]);
    const listed = (await listInvoiceRows(W, { scope: "out" })).find((r) => r.id === l.id)!;
    expect(listed).toMatchObject({ amount: 1000, paidAmount: 400, balance: 600, status: "invoiced" });
    expect((await owedNow()).overdueCount).toBe(before.overdueCount);
    expect((await owedNow()).totalOutstanding).toBe(before.totalOutstanding - 400); // ageing counts what is owed, not the invoice
    expect(owedOf(1000, 400)).toBe(600);
    const inv = await getInvoice(l.id, W);
    expect(inv).toMatchObject({ status: "invoiced", total: 1000, paidAmount: 400, balance: 600 });
    expect(inv!.payments.map((p) => p.amount)).toEqual([400]);
    expect((await events(l.id)).find((e) => e.action === "payment_part")).toMatchObject({ summary: expect.stringContaining("$600.00 still owed") });

    // it cannot be taken back while payments are on it
    expect(await voidInvoice(l.id, "Wrong customer", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Payments have been recorded") });
    // two payments at once for the balance: only one is recorded
    const both = await Promise.all([markLoadPaid(l.id, new Date(), { amount: 600 }, W), markLoadPaid(l.id, new Date(), { amount: 600 }, W)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    row = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([row.paymentStatus, Number(row.paidAmount)]).toEqual(["paid", 1000]);
    expect(await prisma.loadPayment.count({ where: { loadId: l.id } })).toBe(2);
    expect((await listInvoiceRows(W, { scope: "paid" })).find((r) => r.id === l.id)).toMatchObject({ paidDifference: 0, balance: 0 });

    // taking the latest payment back reopens it for what is then owed; then the earlier one; then nothing is left to take back
    expect(await undoPaid(l.id, "x", new Date(), W)).toMatchObject({ ok: false });
    expect(await undoPaid(l.id, "Bounced", new Date(), W)).toEqual({ ok: true });
    row = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([row.paymentStatus, Number(row.paidAmount), row.paidAt]).toEqual(["invoiced", 400, null]);
    expect((await getInvoice(l.id, W))!.balance).toBe(600);
    expect(await undoPaid(l.id, "Entered on the wrong invoice", new Date(), W)).toEqual({ ok: true });
    row = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([row.paymentStatus, row.paidAmount]).toEqual(["invoiced", null]);
    expect(await undoPaid(l.id, "Nothing to take back", new Date(), W)).toMatchObject({ ok: false });
    expect(await prisma.loadPayment.count({ where: { loadId: l.id } })).toBe(0);
    // with no payment on it the invoice can be taken back again
    expect(await voidInvoice(l.id, "Wrong customer", new Date(), W)).toEqual({ ok: true });
  });

  test("part payments, then the rest written off with a reason, close the invoice for what came in; more than is owed is recorded as over", async () => {
    const { invoiceLoad, markLoadPaid } = await import("@/server/tl/invoicing");
    const l = await mkLoad({ status: "completed", completedAt: day(-2), actualRevenue: 1000 }, -4);
    await invoiceLoad(l.id, {}, new Date(), W);
    expect(await markLoadPaid(l.id, new Date(), { amount: 250 }, W)).toEqual({ ok: true, balance: 750 });
    expect(await markLoadPaid(l.id, new Date(), { amount: 500 }, W)).toEqual({ ok: true, balance: 250 });
    expect(await markLoadPaid(l.id, new Date(), { amount: 200, shortAction: "writeoff", shortReason: "Agreed deduction for a late delivery" }, W)).toEqual({ ok: true, difference: -50 });
    const done = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([done.paymentStatus, Number(done.paidAmount)]).toEqual(["paid", 950]);
    expect((await events(l.id)).filter((e) => e.action === "payment_part")).toHaveLength(2);
    expect((await events(l.id)).find((e) => e.action === "paid")).toMatchObject({ reason: "Agreed deduction for a late delivery", summary: expect.stringContaining("$950.00 in all") });

    const over = await mkLoad({ status: "completed", completedAt: day(-2), quotedRevenue: 500, actualRevenue: 500 }, -4);
    await invoiceLoad(over.id, {}, new Date(), W);
    expect(await markLoadPaid(over.id, new Date(), { amount: 520 }, W)).toEqual({ ok: true, difference: 20 });
    expect(await markLoadPaid(over.id, new Date(), { amount: 10.005 }, W)).toMatchObject({ ok: false });
  });

  test("an invoice can be taken back with a reason; not a paid one, not one the factor has, and the load can be invoiced again", async () => {
    const { invoiceLoad, markLoadPaid, voidInvoice } = await import("@/server/tl/invoicing");
    const l = await mkLoad({ status: "completed", completedAt: day(-2), actualRevenue: 1000 }, -4);
    expect(await voidInvoice(l.id, "Wrong customer", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("no invoice") });
    await invoiceLoad(l.id, {}, new Date(), W);
    expect(await voidInvoice(l.id, "x", new Date(), W)).toMatchObject({ ok: false });
    await prisma.load.update({ where: { id: l.id }, data: { factoringStatus: "submitted" } });
    expect(await voidInvoice(l.id, "Wrong customer", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("factoring") });
    await prisma.load.update({ where: { id: l.id }, data: { factoringStatus: "none" } });
    expect(await voidInvoice(l.id, "Wrong customer", new Date(), W)).toEqual({ ok: true });
    const back = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect([back.paymentStatus, back.invoicedAt, back.invoiceNumber, back.invoicedAmount]).toEqual([null, null, null, null]);
    expect((await events(l.id)).find((e) => e.action === "invoice_voided")).toMatchObject({ reason: "Wrong customer" });
    expect(await invoiceLoad(l.id, {}, new Date(), W)).toMatchObject({ ok: true });
    await markLoadPaid(l.id, new Date(), {}, W);
    expect(await voidInvoice(l.id, "Too late", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("paid") });
  });

  test("a statement that went to payroll cannot be voided; one that did not can", async () => {
    const { voidSettlement } = await import("@/server/tl/settlement");
    const make = (number: string, extra: object = {}) => prisma.settlement.create({ data: { workspaceId: W, number, driverId: driver1, status: "final", periodStart: day(-30), periodEnd: day(-23), finalizedAt: day(-20), total: 500, lines: [], ...extra } });
    const sent = await make("C-ST-1", { payrollSentAt: day(-1), payrollReference: "PAY-9" });
    expect(await voidSettlement(sent.id, "Mistake", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("sent to payroll") });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("final");
    const free = await make("C-ST-2");
    expect(await voidSettlement(free.id, "Mistake", new Date(), W)).toMatchObject({ ok: true });
  });

  test("a statement goes to payroll once even when two sends race, and a failed send gives its claim back", async () => {
    const { partnerAdapters } = await import("@/server/partners/call");
    const { connectPartner } = await import("@/server/partners/connections");
    const { sendToPayroll } = await import("@/server/partners/payroll");
    const originals = { ...partnerAdapters };
    try {
      process.env.GUSTO_CLIENT_ID = "a";
      process.env.GUSTO_CLIENT_SECRET = "b";
      await connectPartner("payroll", "gusto", null, new Date(), W);
      const s = await prisma.settlement.create({ data: { workspaceId: W, number: "C-ST-3", driverId: driver1, status: "final", periodStart: day(-30), periodEnd: day(-23), finalizedAt: day(-20), total: 800, lines: [] } });

      let calls = 0;
      let fail = true;
      (partnerAdapters as Record<string, unknown>).payroll = async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 60));
        return fail ? { ok: false, code: "upstream_error", message: "down" } : { ok: true, data: { reference: "PAY-C" } };
      };
      // the first attempt fails: nothing is left claimed, so it can be sent again
      expect(await sendToPayroll([s.id], new Date(), W)).toMatchObject({ ok: false });
      expect(await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ payrollSentAt: null, payrollReference: null });

      fail = false;
      calls = 0;
      const both = await Promise.all([sendToPayroll([s.id], new Date(), W), sendToPayroll([s.id], new Date(), W)]);
      expect(both.filter((r) => r.ok)).toHaveLength(1);
      expect(calls).toBe(1);
      expect(await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ payrollReference: "PAY-C" });
      expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "payroll_sent" } })).toBe(1);
    } finally {
      Object.assign(partnerAdapters, originals);
    }
  });

  // ── C3: the factoring packet is made of kept files ──────────────────────────────────────────

  test("a typed file name or note is not a document; a kept file is, and what went to the factor stays as it was sent", async () => {
    const { partnerAdapters } = await import("@/server/partners/call");
    const { connectPartner } = await import("@/server/partners/connections");
    const { factorInvoice, getFactoringView } = await import("@/server/partners/factoring");
    const { addLoadDocument, listLoadDocuments, removeLoadDocument, DOCS_PER_LOAD } = await import("@/server/tl/documents");
    const { invoiceLoad } = await import("@/server/tl/invoicing");
    const originals = { ...partnerAdapters };
    try {
      process.env.TRIUMPHPAY_API_KEY = "k";
      await connectPartner("factoring", "triumphpay", null, new Date(), W);
      const l = await mkLoad({ status: "completed", completedAt: day(-2), actualRevenue: 1000, rateConPath: "rc.pdf", podNote: "Signed by J. Smith" }, -4);
      await invoiceLoad(l.id, {}, new Date(), W);
      const kinds = async () => (await getFactoringView(l.id, W))!.manifest.map((m) => [m.kind, m.present]);
      expect(await kinds()).toEqual([["invoice", true], ["rate_confirmation", false], ["proof_of_delivery", false]]);

      const pdf = { ok: true as const, type: { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" as const }, data: new TextEncoder().encode("%PDF-1.4 test"), name: "rc.pdf" };
      expect(await addLoadDocument(l.id, "nonsense", pdf, new Date(), W)).toMatchObject({ ok: false });
      const rc = await addLoadDocument(l.id, "rate_con", pdf, new Date(), W);
      expect(rc).toMatchObject({ ok: true });
      expect(await kinds()).toEqual([["invoice", true], ["rate_confirmation", true], ["proof_of_delivery", false]]);
      await addLoadDocument(l.id, "pod", { ...pdf, name: "pod.pdf" }, new Date(), W);
      expect(await kinds()).toEqual([["invoice", true], ["rate_confirmation", true], ["proof_of_delivery", true]]);
      expect((await listLoadDocuments(l.id, W)).map((d) => [d.kind, d.name])).toEqual([["rate_con", "rc.pdf"], ["pod", "pod.pdf"]]);
      expect((await events(l.id)).filter((e) => e.action === "document_added")).toHaveLength(2);

      expect(await addLoadDocument("not-a-load", "other", pdf, new Date(), W)).toMatchObject({ ok: false });
      for (let i = 0; i < DOCS_PER_LOAD; i++) await addLoadDocument(l.id, "other", { ...pdf, name: `o${i}.pdf` }, new Date(), W);
      expect(await addLoadDocument(l.id, "other", pdf, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("up to") });

      // the packet is full, so the invoice goes; after that the documents are locked
      (partnerAdapters as Record<string, unknown>).factoring = async () => ({ ok: true, data: { referenceId: "F-1", status: "submitted" } });
      const twice = await Promise.all([factorInvoice(l.id, {}, new Date(), W), factorInvoice(l.id, {}, new Date(), W)]);
      expect(twice.filter((r) => r.ok)).toHaveLength(1);
      if (!rc.ok) throw new Error("setup");
      expect(await removeLoadDocument(rc.id, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("factoring") });
    } finally {
      Object.assign(partnerAdapters, originals);
    }
  });

  test("a document is kept for its own desk only: another desk's id finds nothing", async () => {
    const { listLoadDocuments, removeLoadDocument } = await import("@/server/tl/documents");
    const l = await prisma.load.findFirstOrThrow({ where: { workspaceId: W, loadNumber: { startsWith: "C-" }, documents: { some: {} } }, include: { documents: true } });
    expect(await listLoadDocuments(l.id, "somewhere-else")).toEqual([]);
    expect(await removeLoadDocument(l.documents[0]!.id, new Date(), "somewhere-else")).toMatchObject({ ok: false });
  });

  test("no load on the demo desk has two statuses that disagree (the seed, and everything the tests above did, keep to the table)", async () => {
    const loads = await prisma.load.findMany({ where: { workspaceId: { in: [W, "demo-workspace"] }, deletedAt: null }, include: { assignment: { select: { status: true } } } });
    const bad = loads.filter((l) => !statesAgree(l.status, l.assignment?.status ?? null)).map((l) => `${l.loadNumber}: ${l.status} / ${l.assignment?.status}`);
    expect(bad).toEqual([]);
  });

  test("the cents of an invoice extra are read as typed: 19.99, 8.20 and 1.15 are fine, 1.999 and -1 are not", async () => {
    const { validateInvoice } = await import("@/lib/invoicing");
    const form = (lumper: string) => ({ number: "N-1", terms: "30", detention: false, lumper, layover: "", otherLabel: "", other: "" });
    for (const ok of ["19.99", "8.20", "1.15", "0.29", "4.35", "1,250.50", "100000"]) expect(validateInvoice(form(ok), { rate: 1000, surcharge: 0, detention: 0, defaultTerms: 30 }), ok).toMatchObject({ ok: true });
    for (const bad of ["1.999", "-1", "1e3", "abc", "100000.01"]) expect(validateInvoice(form(bad), { rate: 1000, surcharge: 0, detention: 0, defaultTerms: 30 }), bad).toMatchObject({ ok: false });
  });
});

/** A Dallas wall-clock text ("2027-03-02T09:00") for a date, as the edit form holds times. */
function toLocalText(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}
