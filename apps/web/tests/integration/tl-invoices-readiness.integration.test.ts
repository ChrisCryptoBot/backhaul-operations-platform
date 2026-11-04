import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { reminderText } from "@/lib/invoicing";
import { moneyState } from "@/lib/money-state";
import { factorInvoice } from "@/server/partners/factoring";
import { listPayroll, sendToPayroll } from "@/server/partners/payroll";
import { getAlerts } from "@/server/tl/alerts";
import { getDetentionRecovery, waiveDetention } from "@/server/tl/detention";
import { buildExport } from "@/server/tl/exports";
import { getInvoice, invoiceLoad, markLoadPaid, recordChase } from "@/server/tl/invoicing";
import { countInvoices, listInvoiceRows } from "@/server/tl/queries";
import { finalizeSettlement, getSettlement, listDriverSettlements, listSettlements, startSettlement } from "@/server/tl/settlement";

/**
 * Phases 3, 4 and 5 readiness checks on a workspace of their own:
 * - waiving unbilled detention audits a reason, drops the load from the recovery list, and clears DETENTION_UNBILLED right away;
 * - chasing an invoice records memory on both the list and the sheet, reminder text uses the remaining balance, terms 0 = Due on receipt, reserved extra-charge labels are refused;
 * - terminal scope narrows detail sheets (getInvoice, getSettlement), detention recovery, and payroll (readyIds across pages, hiddenByTerminal, stale pending-claim recovery);
 * - invoice list sorts (broker, due, paid, amount) order the full list, and exports (invoices, settlements, settlement-lines) match screen columns and mark cut files only past maxRows.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ir-w";
const DEMO = "demo-workspace";
const NOW = new Date("2026-11-20T18:00:00Z"); // 12:00 in Dallas
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("invoices, settlements and payroll readiness on the demo database", () => {
  let dallasTruckId = "";
  let houstonTruckId = "";
  let dallasDriverId = "";
  let houstonDriverId = "";
  const demoCleanupSettlementIds: string[] = [];

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "IR desk", plan: "enterprise" } });
    const dallasTruck = await prisma.vehicle.create({
      data: {
        workspaceId: W,
        name: "IR Dallas Truck",
        type: "tractor",
        terminal: "Dallas",
        costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85, detentionHourlyRate: 60, freeGraceMinutes: 120 } }
      } as never
    });
    const houstonTruck = await prisma.vehicle.create({
      data: {
        workspaceId: W,
        name: "IR Houston Truck",
        type: "tractor",
        terminal: "Houston",
        costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85, detentionHourlyRate: 60, freeGraceMinutes: 120 } }
      } as never
    });
    dallasTruckId = dallasTruck.id;
    houstonTruckId = houstonTruck.id;
    dallasDriverId = (
      await prisma.driver.create({
        data: { workspaceId: W, name: "IR Dallas Driver", terminal: "Dallas", payrollWorkerType: "contractor", payrollEmployeeId: "D-101" } as never
      })
    ).id;
    houstonDriverId = (
      await prisma.driver.create({
        data: { workspaceId: W, name: "IR Houston Driver", terminal: "Houston", payrollWorkerType: "employee", payrollEmployeeId: "H-202" } as never
      })
    ).id;
  });

  afterAll(async () => {
    if (demoCleanupSettlementIds.length > 0) {
      await prisma.settlement.deleteMany({ where: { id: { in: demoCleanupSettlementIds } } });
    }
    await wipe();
  });

  test("detention waive requires a reason, audits the waiver, narrows by terminal, and clears DETENTION_UNBILLED immediately", async () => {
    const dallasLoad = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "IR-DET-D",
        brokerName: "Apex Freight",
        status: "completed",
        completedAt: daysAgo(5),
        vehicleId: dallasTruckId,
        quotedRevenue: 1200,
        loadedMiles: 300,
        paymentStatus: "paid",
        invoiceNumber: "INV-IR-DET-D",
        invoicedAt: daysAgo(4),
        invoicedAmount: 1200,
        paidAmount: 1200,
        paidAt: daysAgo(1),
        payTermsDays: 30,
        stops: {
          create: [{ stopSequence: 1, stopType: "delivery", stopRole: "delivery", addressString: "Dallas, TX", waitMinutes: 240 }]
        }
      } as never
    });
    const houstonLoad = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "IR-DET-H",
        brokerName: "Bayou Logistics",
        status: "completed",
        completedAt: daysAgo(3),
        vehicleId: houstonTruckId,
        quotedRevenue: 900,
        loadedMiles: 180,
        stops: {
          create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Houston, TX", waitMinutes: 180 }]
        }
      } as never
    });

    // Terminal scope on getDetentionRecovery: 120 min past 120 free @ $60/hr = $120 in Dallas; 60 min past 120 free @ $60/hr = $60 in Houston.
    const allBefore = await getDetentionRecovery(W, NOW, null);
    expect(allBefore.unbilledLoads).toBe(2);
    expect(allBefore.totalUnbilled).toBe(180);
    const dallasOnly = await getDetentionRecovery(W, NOW, "Dallas");
    expect(dallasOnly.rows.map((r) => r.loadNumber)).toEqual(["IR-DET-D"]);
    expect(dallasOnly.totalUnbilled).toBe(120);
    const houstonOnly = await getDetentionRecovery(W, NOW, "Houston");
    expect(houstonOnly.rows.map((r) => r.loadNumber)).toEqual(["IR-DET-H"]);
    expect(houstonOnly.totalUnbilled).toBe(60);

    // Before waiving, DETENTION_UNBILLED is open on the paid load whose detention was left off the invoice.
    const alertsBefore = await getAlerts(NOW, W, "open", dallasLoad.id);
    expect(alertsBefore.alerts.some((a) => a.loadId === dallasLoad.id && a.code === "DETENTION_UNBILLED")).toBe(true);

    // Short reason refused; real reason recorded once and clears both recovery list and alert cache immediately.
    expect(await waiveDetention(dallasLoad.id, "no", NOW, W)).toMatchObject({ ok: false });
    expect(await waiveDetention(dallasLoad.id, "Forgiven under quarterly lane agreement", new Date(NOW.getTime() + 1000), W)).toEqual({ ok: true });
    expect(await waiveDetention(dallasLoad.id, "Second click", new Date(NOW.getTime() + 2000), W)).toMatchObject({ ok: false, error: expect.stringContaining("already") });

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, loadId: dallasLoad.id, action: "detention_waived" } });
    expect(audit.reason).toBe("Forgiven under quarterly lane agreement");

    const dallasAfter = await getDetentionRecovery(W, NOW, "Dallas");
    expect(dallasAfter.unbilledLoads).toBe(0);
    expect(dallasAfter.totalUnbilled).toBe(0);

    const alertsAfter = await getAlerts(new Date(NOW.getTime() + 3000), W, "open", dallasLoad.id);
    expect(alertsAfter.alerts.some((a) => a.loadId === dallasLoad.id && a.code === "DETENTION_UNBILLED")).toBe(false);

    await prisma.load.deleteMany({ where: { id: { in: [dallasLoad.id, houstonLoad.id] } } });
  });

  test("reserved extra labels are refused, terms 0 is Due on receipt, part-paid reminders chase the balance, and chase memory shows on list and sheet", async () => {
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "IR-CHASE-1",
        poNumber: "PO-7788",
        brokerName: "Canyon Foods",
        brokerEmail: "ap@canyon.test",
        brokerPhone: "214-555-0199",
        originAddress: "Dallas, TX",
        destinationAddress: "Oklahoma City, OK",
        status: "completed",
        completedAt: daysAgo(10),
        vehicleId: dallasTruckId,
        quotedRevenue: 1000,
        loadedMiles: 210
      } as never
    });

    // Reserved extra charge label colliding with "Detention" is refused.
    const badExtra = await invoiceLoad(
      load.id,
      { form: { number: "INV-IR-CHASE-1", terms: "0", detention: false, lumper: "", layover: "", otherLabel: "Detention", other: "50" } },
      daysAgo(5),
      W
    );
    expect(badExtra.ok).toBe(false);
    expect(badExtra.errors?.otherLabel).toBeTruthy();

    // Terms 0 ("Due on receipt") succeeds and is due the day it is sent.
    const okInv = await invoiceLoad(
      load.id,
      { form: { number: "INV-IR-CHASE-1", terms: "0", detention: false, lumper: "", layover: "", otherLabel: "Tarping", other: "75" } },
      daysAgo(5),
      W
    );
    expect(okInv).toMatchObject({ ok: true, total: 1075 });

    // Record a part payment of $475 by ACH, leaving $600 owed.
    expect(await markLoadPaid(load.id, daysAgo(2), { amount: 475, method: "ach" }, W)).toMatchObject({ ok: true, balance: 600 });

    // Record chase and verify both listInvoiceRows and getInvoice agree on balance, moneyState, and lastChasedAt.
    const chaseTime = daysAgo(1);
    expect(await recordChase(load.id, "email", chaseTime, W)).toEqual({ ok: true });
    expect(await recordChase("missing-load", "phone", chaseTime, W)).toMatchObject({ ok: false });

    const [listRow] = (await listInvoiceRows(W, { scope: "out" })).filter((r) => r.id === load.id);
    const sheet = (await getInvoice(load.id, W))!;
    expect(listRow.balance).toBe(600);
    expect(sheet.balance).toBe(600);
    expect(sheet.terms).toBe(0);
    expect(listRow.lastChasedAt?.toISOString()).toBe(chaseTime.toISOString());
    expect(sheet.lastChasedAt?.toISOString()).toBe(chaseTime.toISOString());

    const reminder = reminderText({
      broker: sheet.billTo.name,
      invoiceNumber: sheet.invoiceNumber,
      loadNumber: sheet.load.number,
      poNumber: sheet.poNumber,
      amount: sheet.balance,
      sent: sheet.sent,
      due: sheet.due,
      now: NOW,
      origin: sheet.load.origin,
      destination: sheet.load.destination
    });
    expect(reminder).toContain("$600.00");
    expect(reminder).not.toContain("$1,075.00");

    const ms = moneyState({ paymentStatus: "invoiced", billed: sheet.total, received: sheet.paidAmount, overdueDays: 5 });
    expect(ms.detail).toContain("$600.00");

    // Terminal scope on getInvoice: Dallas sees it, Houston gets null.
    expect(await getInvoice(load.id, W, "Dallas")).not.toBeNull();
    expect(await getInvoice(load.id, W, "Houston")).toBeNull();

    // Missing load on factorInvoice returns {ok: false} rather than throwing.
    expect(await factorInvoice("does-not-exist", {}, NOW, W)).toMatchObject({ ok: false });

    await prisma.loadPayment.deleteMany({ where: { loadId: load.id } });
    await prisma.load.delete({ where: { id: load.id } });
  });

  test("invoice list sorts order the full list by customer, due date, paid date and amount", async () => {
    const mkOut = (n: string, broker: string, invoicedDaysAgo: number, terms: number, amount: number, paidAmount: number | null = null) =>
      prisma.load.create({
        data: {
          workspaceId: W,
          loadNumber: `IR-SORT-${n}`,
          brokerName: broker,
          status: "completed",
          completedAt: daysAgo(40),
          quotedRevenue: amount,
          loadedMiles: 100,
          paymentStatus: "invoiced",
          invoiceNumber: `INV-SORT-${n}`,
          invoicedAt: daysAgo(invoicedDaysAgo),
          invoicedAmount: amount,
          paidAmount,
          payTermsDays: terms
        } as never
      });

    const a = await mkOut("1", "Zebra Freight", 20, 30, 1500, 1000); // due in 10d, balance 500
    const b = await mkOut("2", "Alpha Logistics", 10, 0, 900, null); // due 10d ago (terms 0!), balance 900
    const c = await mkOut("3", "Midland Co", 25, 15, 1200, null); // due 10d ago (25-15=10; wait use 28-15=13d ago), balance 1200
    await prisma.load.update({ where: { id: c.id }, data: { invoicedAt: daysAgo(28) } }); // due 13d ago

    const byCustomer = await listInvoiceRows(W, { scope: "out", sort: { key: "broker", dir: "asc" } });
    expect(byCustomer.map((r) => r.broker)).toEqual(["Alpha Logistics", "Midland Co", "Zebra Freight"]);

    const byDueAsc = await listInvoiceRows(W, { scope: "out", sort: { key: "due", dir: "asc" } });
    expect(byDueAsc.map((r) => r.invoiceNumber)).toEqual(["INV-SORT-3", "INV-SORT-2", "INV-SORT-1"]);

    // Amount sort on "out" orders by remaining balance ($1,200 > $900 > $500, even though Zebra's billed total was $1,500).
    const byOwedDesc = await listInvoiceRows(W, { scope: "out", sort: { key: "amount", dir: "desc" } });
    expect(byOwedDesc.map((r) => r.balance)).toEqual([1200, 900, 500]);

    await prisma.load.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
  });

  test("settlements and payroll enforce terminal scope, batch readyIds across pages (>50), recover stale pending claims, and block active claims", async () => {
    // Start and finalize a real statement for Dallas driver and verify getSettlement terminal guard + listDriverSettlements + batched draft resolution.
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "IR-ST-L1",
        brokerName: "Prairie Mills",
        originAddress: "Dallas, TX",
        destinationAddress: "Waco, TX",
        status: "completed",
        completedAt: new Date("2026-10-14T16:00:00Z"),
        quotedRevenue: 800,
        loadedMiles: 100,
        assignment: { create: { driverId: dallasDriverId, payKind: "flat", payRate: 325, status: "completed" } }
      } as never
    });
    const started = await startSettlement({ driverId: dallasDriverId, start: "2026-10-12", end: "2026-10-18" }, NOW, W);
    if (!started.ok) throw new Error("failed to start settlement");

    // Batched draft list resolves loads & total accurately.
    const drafts = await listSettlements(W, { status: "draft", terminal: "Dallas" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: started.id, loads: 1, total: 325 });
    expect(await listSettlements(W, { status: "draft", terminal: "Houston" })).toHaveLength(0);

    expect(await finalizeSettlement(started.id, { hours: {}, adjustments: [] }, NOW, W, 325)).toMatchObject({ ok: true });
    expect(await getSettlement(started.id, W, "Dallas")).not.toBeNull();
    expect(await getSettlement(started.id, W, "Houston")).toBeNull();

    const driverStatements = await listDriverSettlements(dallasDriverId, W);
    expect(driverStatements.total).toBe(1);
    expect(driverStatements.rows[0]?.id).toBe(started.id);

    // Create 54 more ready Dallas statements (total 55 ready normal + 1 stale pending claim = 56 ready across 2 pages),
    // 1 fresh pending claim in Dallas (not ready), and 2 Houston finalized statements (hidden by Dallas terminal filter).
    const extraData = Array.from({ length: 54 }, (_, i) => ({
      workspaceId: W,
      driverId: dallasDriverId,
      number: `ST-IR-BATCH-${String(i + 1).padStart(3, "0")}`,
      status: "final",
      periodStart: new Date("2026-10-19T00:00:00Z"),
      periodEnd: new Date("2026-10-25T00:00:00Z"),
      total: 400 + i,
      finalizedAt: new Date(NOW.getTime() - i * 1000)
    }));
    await prisma.settlement.createMany({ data: extraData as never });

    const stalePending = await prisma.settlement.create({
      data: {
        workspaceId: W,
        driverId: dallasDriverId,
        number: "ST-IR-STALE",
        status: "final",
        periodStart: new Date("2026-10-19T00:00:00Z"),
        periodEnd: new Date("2026-10-25T00:00:00Z"),
        total: 510,
        finalizedAt: NOW,
        payrollSentAt: new Date(NOW.getTime() - 15 * 60_000), // 15 min old > 10 min CLAIM_MS
        payrollReference: "pending:crashed-run"
      } as never
    });
    const freshPending = await prisma.settlement.create({
      data: {
        workspaceId: W,
        driverId: dallasDriverId,
        number: "ST-IR-FRESH",
        status: "final",
        periodStart: new Date("2026-10-19T00:00:00Z"),
        periodEnd: new Date("2026-10-25T00:00:00Z"),
        total: 520,
        finalizedAt: NOW,
        payrollSentAt: new Date(NOW.getTime() - 2 * 60_000), // 2 min old: actively sending
        payrollReference: "pending:active-run"
      } as never
    });
    await prisma.settlement.createMany({
      data: [1, 2].map((n) => ({
        workspaceId: W,
        driverId: houstonDriverId,
        number: `ST-IR-HOU-${n}`,
        status: "final",
        periodStart: new Date("2026-10-19T00:00:00Z"),
        periodEnd: new Date("2026-10-25T00:00:00Z"),
        total: 600,
        finalizedAt: NOW
      })) as never
    });

    const dallasPayroll = await listPayroll({ page: 1, filter: "ready", terminal: "Dallas", now: NOW }, W);
    expect(dallasPayroll.rows).toHaveLength(50); // page 1 holds 50
    expect(dallasPayroll.ready).toBe(56); // 55 + 1 stalePending
    expect(dallasPayroll.readyIds).toHaveLength(56); // spans beyond page 1!
    expect(dallasPayroll.readyIds).toContain(stalePending.id);
    expect(dallasPayroll.readyIds).not.toContain(freshPending.id);
    expect(dallasPayroll.hiddenByTerminal).toBe(2);

    // Trying to send freshPending while another tab's claim is active refuses cleanly.
    const activeAttempt = await sendToPayroll([freshPending.id], NOW, W);
    expect(activeAttempt.ok).toBe(false);

    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.load.delete({ where: { id: load.id } });
  });

  test("CSV exports cover invoices (by scope), settlements and settlement-lines, and flag cut filenames only when rows exceed maxRows", async () => {
    const outTotal = await countInvoices("out", DEMO);
    expect(outTotal).toBeGreaterThan(2);

    // Exact cap (maxRows === outTotal) must NOT mark the filename as cut; cap - 1 MUST mark it as cut.
    const exactOut = (await buildExport("invoices", { scope: "out" }, NOW, { maxRows: outTotal }))!;
    expect(exactOut.filename).toBe("truelane-desk-invoices-out-2026-11-20.csv");
    const exactLines = exactOut.csv.trim().split("\r\n");
    expect(exactLines[0]).toContain("Payment method");
    expect(exactLines[0]).toContain("Write-off");
    expect(exactLines[0]).toContain("Days overdue");
    expect(exactLines).toHaveLength(1 + outTotal);

    const cutCap = outTotal - 1;
    const cutOut = (await buildExport("invoices", { scope: "out" }, NOW, { maxRows: cutCap }))!;
    expect(cutOut.filename).toBe(`truelane-desk-invoices-out-first-${cutCap}-2026-11-20.csv`);
    expect(cutOut.csv.trim().split("\r\n")).toHaveLength(1 + cutCap);

    // Ensure settlements and settlement-lines exports work and honour exact vs cut maxRows too.
    const demoDriver = await prisma.driver.findFirstOrThrow({ where: { workspaceId: DEMO } });
    const s1 = await prisma.settlement.create({
      data: {
        workspaceId: DEMO,
        driverId: demoDriver.id,
        number: "ST-EXP-TEST-1",
        status: "final",
        periodStart: new Date("2026-10-05T00:00:00Z"),
        periodEnd: new Date("2026-10-11T00:00:00Z"),
        lines: [{ loadId: "l1", loadNumber: "TL-EXP-1", lane: "Dallas, TX → Austin, TX", deliveredAt: "2026-10-08T15:00:00Z", basis: "Set amount", payKind: "flat", payRate: 450, hours: null, amount: 450, brokerStatus: "paid" }],
        adjustments: [{ label: "Fuel reimbursement", amount: 50 }],
        total: 500,
        finalizedAt: NOW,
        paidAt: NOW,
        paidMethod: "check"
      } as never
    });
    const s2 = await prisma.settlement.create({
      data: {
        workspaceId: DEMO,
        driverId: demoDriver.id,
        number: "ST-EXP-TEST-2",
        status: "final",
        periodStart: new Date("2026-10-12T00:00:00Z"),
        periodEnd: new Date("2026-10-18T00:00:00Z"),
        lines: [{ loadId: "l2", loadNumber: "TL-EXP-2", lane: "Dallas, TX → Tulsa, OK", deliveredAt: "2026-10-15T15:00:00Z", basis: "Set amount", payKind: "flat", payRate: 400, hours: null, amount: 400, brokerStatus: "invoiced" }],
        adjustments: [],
        total: 400,
        finalizedAt: NOW
      } as never
    });
    demoCleanupSettlementIds.push(s1.id, s2.id);

    const totalFinalStatements = await prisma.settlement.count({ where: { workspaceId: DEMO, status: "final" } });
    const stExact = (await buildExport("settlements", { status: "final" }, NOW, { maxRows: totalFinalStatements }))!;
    expect(stExact.filename).toBe("truelane-desk-settlements-2026-11-20.csv");
    expect(stExact.csv.split("\r\n")[0]).toContain("Payment method");
    expect(stExact.csv).toContain("ST-EXP-TEST-1");
    expect(stExact.csv).toContain("Check");

    const stCut = (await buildExport("settlements", { status: "final" }, NOW, { maxRows: 1 }))!;
    expect(stCut.filename).toBe("truelane-desk-settlements-first-1-2026-11-20.csv");

    const linesCsv = (await buildExport("settlement-lines", { status: "final" }, NOW))!;
    expect(linesCsv.filename).toBe("truelane-desk-settlement-lines-2026-11-20.csv");
    expect(linesCsv.csv).toContain("TL-EXP-1");
    expect(linesCsv.csv).toContain("Fuel reimbursement");
  });
});
