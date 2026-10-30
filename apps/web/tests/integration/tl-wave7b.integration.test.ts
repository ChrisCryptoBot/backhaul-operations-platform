import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, driverSummaryFor } from "@/server/tl/dispatch";
import { listBoardRows } from "@/server/tl/queries";
import { discardSettlement, eligibleLoads, finalizeSettlement, getSettlement, listSettlements, saveDraft, settlementOfLoad, startSettlement, unsettledByDriver, voidSettlement } from "@/server/tl/settlement";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own drivers and loads (all named W7B) and removes them, their
 * statements and their audit events afterwards. Every delivery is in October 2026 (Dallas is on daylight time, UTC-5, until 1 November).
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const PERIOD = { start: "2026-10-12", end: "2026-10-18" };

describe.skipIf(!run)("percent pay and driver statements on the demo database", () => {
  const startedAt = new Date();
  let driverId = "";
  let otherDriverId = "";
  const L: Record<string, string> = {};
  const at = (local: string) => new Date(`${local}:00-05:00`);

  const delivered = (n: string, local: string, pay: { kind: string; rate: number; estimate?: number | null }, over: Record<string, unknown> = {}, who = () => driverId) =>
    prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `W7B-${n}`,
        brokerName: "W7B Broker",
        status: "completed",
        completedAt: at(local),
        quotedRevenue: 1000,
        fuelSurcharge: 150,
        loadedMiles: 245,
        originAddress: "Dallas, TX",
        destinationAddress: "Memphis, TN",
        paymentStatus: "paid",
        assignment: { create: { driverId: who(), payKind: pay.kind, payRate: pay.rate, payEstimate: pay.estimate ?? null, status: "completed" } },
        ...over
      }
    });
  const events = (action: string) => prisma.auditEvent.findMany({ where: { entity: "settlement", action, createdAt: { gte: startedAt } }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    const a = await prisma.driver.create({ data: { workspaceId: WS, name: "W7B Driver A", cdlExpiry: new Date("2031-01-31"), medicalCardExpiry: new Date("2031-01-31") } });
    const b = await prisma.driver.create({ data: { workspaceId: WS, name: "W7B Driver B", cdlExpiry: new Date("2031-01-31"), medicalCardExpiry: new Date("2031-01-31") } });
    driverId = a.id;
    otherDriverId = b.id;
    L.cpm = (await delivered("1", "2026-10-13T10:00", { kind: "cpm", rate: 0.5 })).id; // 122.50
    L.flat = (await delivered("2", "2026-10-14T10:00", { kind: "flat", rate: 450 })).id; // 450
    L.percent = (await delivered("3", "2026-10-15T10:00", { kind: "percent", rate: 25 })).id; // 25% of 1,150 = 287.50
    L.hourlyEstimated = (await delivered("4", "2026-10-16T10:00", { kind: "hourly", rate: 24, estimate: 204 })).id; // 8.5 hours
    L.hourlyBare = (await delivered("5", "2026-10-17T10:00", { kind: "hourly", rate: 20 })).id; // no hours yet
    L.lastMinute = (await delivered("6", "2026-10-18T23:45", { kind: "flat", rate: 100 })).id; // the last minutes of the last day
    L.before = (await delivered("7-BEFORE", "2026-10-11T23:30", { kind: "flat", rate: 11 })).id;
    L.midnight = (await delivered("8-MIDNIGHT", "2026-10-19T00:00", { kind: "flat", rate: 12 })).id; // the first instant after the period
    L.other = (await delivered("9-OTHER", "2026-10-14T12:00", { kind: "flat", rate: 99 }, {}, () => otherDriverId)).id;
    const open = await delivered("10-OPEN", "2026-10-14T13:00", { kind: "flat", rate: 77 }, { status: "in_progress", completedAt: null });
    await prisma.assignment.update({ where: { loadId: open.id }, data: { status: "in_progress" } });
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, loadNumber: { startsWith: "W7B-" } }, select: { id: true } });
    const ids = [...mine.map((l) => l.id), ...(L.pct ? [L.pct] : [])];
    await prisma.settlementLoad.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { driver: { name: { startsWith: "W7B" } } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "settlement" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W7B" } } });
  });

  test("a percent of the rate is a pay kind: the estimate is that share of the rate plus fuel surcharge, the driver is told the dollars, and 100% is refused", async () => {
    const driver = await prisma.driver.create({ data: { workspaceId: WS, name: "W7B Percent Driver", cdlExpiry: new Date("2031-01-31"), medicalCardExpiry: new Date("2031-01-31") } });
    const load = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "W7B-PCT", status: "draft", quotedRevenue: 1000, fuelSurcharge: 150, loadedMiles: 245, originAddress: "Dallas, TX", destinationAddress: "Memphis, TN" } });

    const a = await assignDriver({ loadId: load.id, driverId: driver.id, pay: { kind: "percent", rate: 25 } });
    expect(a.payKind).toBe("percent");
    expect(Number(a.payRate)).toBe(25);
    expect(Number(a.payEstimate)).toBe(287.5);
    await expect(assignDriver({ loadId: load.id, driverId: driver.id, pay: { kind: "percent", rate: 100 } })).rejects.toBeInstanceOf(DispatchError);
    await expect(assignDriver({ loadId: load.id, driverId: driver.id, pay: { kind: "percent", rate: 0 } })).rejects.toBeInstanceOf(DispatchError);
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { loadId: load.id } }))).toContain("25% of the rate");

    await dispatchLoad(load.id);
    const sent = await driverSummaryFor(load.id);
    expect(sent.driver_pay).toEqual({ kind: "flat", rate: 287.5, estimate: 287.5 });
    expect(JSON.stringify(sent)).not.toMatch(/1150|percent|25%/);

    // A set amount is still a set amount.
    const flat = await assignDriver({ loadId: load.id, driverId: driver.id, pay: { kind: "flat", rate: 410 } });
    expect(Number(flat.payEstimate)).toBe(410);
    L.pct = load.id; // kept for cleanup: its audit events outlive the load
  });

  test("a period runs midnight to midnight in Dallas, for one driver's delivered loads only; an empty period and a bad one say so", async () => {
    const eligible = await eligibleLoads(driverId, PERIOD.start, PERIOD.end);
    expect(eligible.map((l) => l.loadNumber)).toEqual(["W7B-1", "W7B-2", "W7B-3", "W7B-4", "W7B-5", "W7B-6"]);
    const midnight = await eligibleLoads(driverId, "2026-10-19", "2026-10-19");
    expect(midnight.map((l) => l.loadNumber)).toEqual(["W7B-8-MIDNIGHT"]);

    expect(await startSettlement({ driverId, start: PERIOD.end, end: PERIOD.start })).toMatchObject({ ok: false, errors: { end: expect.any(String) } });
    const empty = await startSettlement({ driverId, start: "2026-09-01", end: "2026-09-07" });
    expect(empty).toMatchObject({ ok: false, error: expect.stringContaining("No delivered loads for W7B Driver A") });
    expect(await startSettlement({ driverId: "nobody", ...PERIOD })).toMatchObject({ ok: false });
  });

  test("a draft pays each load under its own pay: miles, a set amount, a percent of the rate, hours (the assignment's, or typed), and needs hours where there are none", async () => {
    const started = await startSettlement({ driverId, ...PERIOD });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    L.draft1 = started.id;
    const view = (await getSettlement(started.id))!;
    expect(view).toMatchObject({ status: "draft", periodLabel: "Oct 12 to Oct 18, 2026", driver: { name: "W7B Driver A" }, issuer: "Demo fleet" });
    expect(view.number).toMatch(/^ST-\d{4}$/);
    expect(view.statement.lines.map((l) => l.amount)).toEqual([122.5, 450, 287.5, 204, null, 100]);
    expect(view.statement.blockers).toEqual(["Enter the hours for W7B-5."]);
    expect(await finalizeSettlement(started.id, { hours: {}, adjustments: [] })).toMatchObject({ ok: false, error: "Enter the hours for W7B-5." });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: started.id } })).status).toBe("draft");

    const second = await startSettlement({ driverId, ...PERIOD }); // a second draft over the same loads is allowed until one is finalized
    expect(second.ok).toBe(true);
    if (second.ok) L.draft2 = second.id;
    const numbers = [started, second].map(async (r) => (r.ok ? (await getSettlement(r.id))!.number : ""));
    const [n1, n2] = await Promise.all(numbers);
    expect(n1).not.toBe(n2);
    expect((await listSettlements()).filter((s) => s.driverName === "W7B Driver A" && s.status === "draft")).toHaveLength(2);
  });

  test("hours and adjustments are kept as typed, a bad one is refused, and the total is the loads plus the adjustments", async () => {
    const draft = { hours: { [L.hourlyEstimated!]: "9", [L.hourlyBare!]: "10" }, adjustments: [{ label: "Advance", amount: "-100" }, { label: "Tolls reimbursed", amount: "42.35" }, { label: "", amount: "" }] };
    expect(await saveDraft(L.draft1!, { hours: { [L.hourlyBare!]: "abc" }, adjustments: [] })).toMatchObject({ ok: false, errors: { [`hours.${L.hourlyBare}`]: expect.any(String) } });
    expect(await saveDraft(L.draft1!, { hours: {}, adjustments: [{ label: "", amount: "50" }] })).toMatchObject({ ok: false, errors: { "adj0.label": expect.any(String) } });
    expect(await saveDraft(L.draft1!, draft)).toMatchObject({ ok: true });

    const view = (await getSettlement(L.draft1!))!;
    expect(view.hours).toEqual({ [L.hourlyEstimated!]: "9", [L.hourlyBare!]: "10" });
    expect(view.adjustmentRows).toEqual([{ label: "Advance", amount: "-100" }, { label: "Tolls reimbursed", amount: "42.35" }]);
    expect(view.statement.lines.map((l) => l.amount)).toEqual([122.5, 450, 287.5, 216, 200, 100]);
    expect(view.statement.loadsTotal).toBe(1376);
    expect(view.statement.adjustmentsTotal).toBe(-57.65);
    expect(view.statement.total).toBe(1318.35);
    expect(view.statement.blockers).toEqual([]);
  });

  test("finalizing freezes the lines and the total, ties each load to the statement, and the database itself will not pay a load twice", async () => {
    const draft = { hours: { [L.hourlyEstimated!]: "9", [L.hourlyBare!]: "10" }, adjustments: [{ label: "Advance", amount: "-100" }, { label: "Tolls reimbursed", amount: "42.35" }] };
    expect(await finalizeSettlement(L.draft1!, draft)).toEqual({ ok: true, id: L.draft1 });

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: L.draft1! }, include: { loads: true } });
    expect(row.status).toBe("final");
    expect(Number(row.total)).toBe(1318.35);
    expect(row.finalizedAt).not.toBeNull();
    expect(row.loads).toHaveLength(6);
    expect(row.loads.map((l) => Number(l.amount)).sort((x, y) => x - y)).toEqual([100, 122.5, 200, 216, 287.5, 450]);
    expect(await settlementOfLoad(L.cpm!)).toMatchObject({ id: L.draft1 });
    expect(await settlementOfLoad(L.before!)).toBeNull();

    // Frozen: the load changing afterwards does not rewrite what was paid.
    await prisma.load.update({ where: { id: L.cpm! }, data: { loadedMiles: 999 } });
    const frozen = (await getSettlement(L.draft1!))!;
    expect(frozen.status).toBe("final");
    expect(frozen.statement.lines[0]!.amount).toBe(122.5);
    expect(frozen.statement.total).toBe(1318.35);

    // Once final it is closed to edits, a repeat, and another statement taking the same loads.
    expect(await finalizeSettlement(L.draft1!, draft)).toMatchObject({ ok: false, error: expect.stringContaining("already finalized") });
    expect(await saveDraft(L.draft1!, draft)).toMatchObject({ ok: false });
    expect(await discardSettlement(L.draft1!)).toMatchObject({ ok: false, error: expect.stringContaining("voided") });
    expect(await startSettlement({ driverId, ...PERIOD })).toMatchObject({ ok: false, error: expect.stringContaining("No delivered loads") });
    await expect(prisma.settlementLoad.create({ data: { settlementId: L.draft2!, loadId: L.cpm!, amount: 1 } })).rejects.toThrow();

    // The other draft, over the same period, has nothing left to pay.
    expect((await getSettlement(L.draft2!))!.statement.lines).toEqual([]);
    expect(await finalizeSettlement(L.draft2!, { hours: {}, adjustments: [] })).toMatchObject({ ok: false, error: "There is nothing to pay on this statement." });

    const [done] = await events("statement_finalized");
    expect(done!.after).toMatchObject({ Driver: "W7B Driver A", Loads: 6, "Pay for loads": "$1376.00", Adjustments: "$-57.65", Total: "$1318.35" });
    expect(done!.summary).toContain("$1318.35");
  });

  test("voiding needs a reason, keeps the statement as it was, and frees its loads for another statement", async () => {
    expect(await voidSettlement(L.draft1!, "x")).toMatchObject({ ok: false });
    expect(await voidSettlement(L.draft2!, "A draft is discarded, not voided")).toMatchObject({ ok: false, error: expect.stringContaining("finalized") });
    expect(await voidSettlement(L.draft1!, "Paid the wrong week")).toEqual({ ok: true, id: L.draft1 });

    const row = await prisma.settlement.findUniqueOrThrow({ where: { id: L.draft1! }, include: { loads: true } });
    expect(row).toMatchObject({ status: "void", voidReason: "Paid the wrong week" });
    expect(row.loads).toHaveLength(0);
    const view = (await getSettlement(L.draft1!))!;
    expect(view.status).toBe("void");
    expect(view.statement.total).toBe(1318.35); // as it was
    expect(view.statement.lines).toHaveLength(6);
    expect(await settlementOfLoad(L.cpm!)).toBeNull();
    expect(await finalizeSettlement(L.draft1!, { hours: {}, adjustments: [] })).toMatchObject({ ok: false, error: expect.stringContaining("voided") });
    expect(await voidSettlement(L.draft1!, "Again for no reason")).toMatchObject({ ok: false });
    expect((await events("statement_voided"))[0]).toMatchObject({ reason: "Paid the wrong week" });

    // The freed loads are paid on a new statement; the old one stays void.
    const again = await startSettlement({ driverId, ...PERIOD });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect((await getSettlement(again.id))!.loads).toHaveLength(6);
    expect(await discardSettlement(again.id)).toEqual({ ok: true, id: again.id });
    expect(await getSettlement(again.id)).toBeNull();
    expect((await events("statement_discarded"))[0]!.summary).toContain("discarded");
    expect(await discardSettlement(L.draft2!)).toMatchObject({ ok: true });
  });

  test("what is delivered and not yet settled is listed per driver with a period that covers it; a rate confirmation load is paid its percent of the agreed rate", async () => {
    const rateCon = await delivered("11-RATECON", "2026-10-20T10:00", { kind: "percent", rate: 30 }, { quotedRevenue: 1300, fuelSurcharge: null });
    const [line] = await eligibleLoads(driverId, "2026-10-20", "2026-10-20");
    expect(line).toMatchObject({ loadId: rateCon.id, rateConTotal: 1300, payKind: "percent", payRate: 30 });

    const unsettled = (await unsettledByDriver()).find((u) => u.driverId === driverId)!;
    expect(unsettled.loads).toBe(9); // this driver's delivered loads: 1 to 6, 7 (before), 8 (midnight) and 11; 9 is the other driver's and 10 is still on the road
    expect(unsettled.hourlyWithoutHours).toBe(1);
    expect(unsettled).toMatchObject({ start: "2026-10-11", end: "2026-10-20" });
    // The first load now reads 999 miles (changed after it was finalized, then freed by the void): 0.50 a mile is 499.50. The hourly load with no hours adds nothing yet.
    expect(unsettled.amount).toBe(499.5 + 450 + 287.5 + 204 + 100 + 11 + 12 + 390);
    expect((await unsettledByDriver()).some((u) => u.driverId === otherDriverId)).toBe(true);

    // The statement list reflects what has happened.
    const mine = (await listSettlements()).filter((s) => s.driverName === "W7B Driver A");
    expect(mine.map((s) => s.status)).toEqual(["void"]);
    expect(mine[0]).toMatchObject({ loads: 6, total: 1318.35 });
  });

  test("a delivered load paid on a statement still reads as delivered on the board", async () => {
    const row = (await listBoardRows(undefined, "all")).find((r) => r.loadNumber === "W7B-1");
    expect(row).toMatchObject({ status: "completed", paymentStatus: "paid" });
  });
});
