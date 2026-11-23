import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { mirrorDriverPay } from "@/server/bridge/pay";
import { memoryTransport } from "@/server/bridge/transport";
import { recordAdvance } from "@/server/tl/deductions";
import { finalizeSettlement, markSettlementPaid, startSettlement, voidSettlement } from "@/server/tl/settlement";

/**
 * Sync plan Step 5a on the demo database, with the in-memory bridge standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/driver-pay.integration.test.ts
 * It makes its own driver and loads, and takes them away again.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_pay";
const PHONE = "user_test_pay";
const DAY = 86_400_000;

describe.skipIf(!run)("driver pay over the bridge", () => {
  const ws = currentWorkspaceId();
  const t = memoryTransport();
  let savedOrg: string | null = null;
  let driverId = "";
  const loads: string[] = [];
  const now = new Date();
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const mirror = () => mirrorDriverPay(t, { workspaceId: ws, now: new Date() });
  const mine = () => t.statements.filter((s) => s.driver_sub === PHONE);

  const delivered = async (n: string, pay: { kind: string; rate: number }) => {
    const like = await prisma.load.findFirstOrThrow({ where: { workspaceId: ws, loadNumber: "DM-40006" } });
    const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = like;
    void _i; void _c; void _u;
    const l = await prisma.load.create({ data: { ...(rest as object), loadNumber: n, status: "completed", completedAt: new Date(now.getTime() - 2 * DAY), loadedMiles: 400, quotedRevenue: 1150, fuelSurcharge: 0, assignment: { create: { driverId, payKind: pay.kind, payRate: pay.rate, status: "completed" } } } as never });
    loads.push(l.id);
  };

  beforeAll(async () => {
    savedOrg = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } })).bridgeOrgId;
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
    driverId = (await prisma.driver.create({ data: { workspaceId: ws, name: "Pay Test", phoneUserId: PHONE, payrollWorkerType: "contractor" } })).id;
    await delivered("PAY-1", { kind: "cpm", rate: 0.65 });
    await delivered("PAY-2", { kind: "percent", rate: 25 });
  });

  afterAll(async () => {
    const ids = (await prisma.settlement.findMany({ where: { driverId }, select: { id: true } })).map((s) => s.id);
    await prisma.driverLedgerEntry.deleteMany({ where: { driverId } });
    await prisma.driverAdvance.deleteMany({ where: { driverId } });
    await prisma.settlementLoad.deleteMany({ where: { settlementId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { driverId } });
    await prisma.assignment.deleteMany({ where: { driverId } });
    await prisma.load.deleteMany({ where: { id: { in: loads } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: ws, createdAt: { gte: now }, OR: [{ loadId: { in: loads } }, { summary: { contains: "Pay Test" } }] } });
    await prisma.driver.delete({ where: { id: driverId } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: savedOrg } });
  });

  test("before any statement: what is earned and not settled, and nothing else", async () => {
    await mirror();
    expect(mine()).toHaveLength(0);
    expect(t.balances.find((b) => b.driver_sub === PHONE)).toMatchObject({ org_id: ORG, unsettled_cents: 26000 + 28750, unsettled_loads: 2, escrow_cents: 0, advances: [], ytd: null });
    expect(await mirror()).toMatchObject({ statements: 0, balances: 0, removed: 0 });
  });

  test("a Wednesday advance shows on the next run, owed and coming off next", async () => {
    expect(await recordAdvance({ amount: "200", repay: "100", givenOn: ymd(now.getTime() - DAY), method: "cash", note: "" }, driverId, new Date(), ws)).toMatchObject({ ok: true });
    await mirror();
    const b = t.balances.find((x) => x.driver_sub === PHONE)!;
    expect(b.advances).toHaveLength(1);
    expect(b.advances[0]!.owed_cents).toBe(20000);
    expect(b.next_off).toEqual([{ label: b.advances[0]!.label, amount_cents: 10000 }]);
  });

  test("a draft never goes; finalized, it goes with its PDF, says no percent and no rate, and what was unsettled drops", async () => {
    const made = await startSettlement({ driverId, start: ymd(now.getTime() - 5 * DAY), end: ymd(now.getTime()) }, new Date(), ws);
    if (!made.ok) throw new Error(made.error);
    await mirror();
    expect(mine()).toHaveLength(0);
    expect(await finalizeSettlement(made.id, { hours: {}, adjustments: [] }, new Date(), ws)).toMatchObject({ ok: true });
    expect(await mirror()).toMatchObject({ statements: 1, failed: 0 });
    const row = mine()[0]!;
    expect(row).toMatchObject({ org_id: ORG, desk_statement_id: made.id, state: "finalized", total_cents: 26000 + 28750 - 10000 });
    expect(row.lines.reduce((n, l) => n + l.amount_cents, 0)).toBe(row.total_cents);
    expect(JSON.stringify(row)).not.toMatch(/1,?150|25%/);
    const pdf = t.files.get(row.pdf_path!)!;
    expect(new TextDecoder("latin1").decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(t.balances.find((b) => b.driver_sub === PHONE)).toMatchObject({ unsettled_cents: 0, unsettled_loads: 0, ytd: { statements: 1, pay_cents: 54750, net_cents: 44750 } });
    expect(await mirror()).toMatchObject({ statements: 0, balances: 0 });
  });

  test("a paid statement says so, with one PDF kept; a voided one says taken back", async () => {
    const id = mine()[0]!.desk_statement_id;
    expect(await voidSettlement(id, "pay test", new Date(), ws)).toMatchObject({ ok: true });
    await mirror();
    expect(mine()[0]).toMatchObject({ state: "void" });
    expect([...t.files.keys()].filter((k) => k.includes(id))).toHaveLength(1);
    const again = await startSettlement({ driverId, start: ymd(now.getTime() - 5 * DAY), end: ymd(now.getTime()) }, new Date(), ws);
    if (!again.ok) throw new Error(again.error);
    await finalizeSettlement(again.id, { hours: {}, adjustments: [] }, new Date(), ws);
    expect(await markSettlementPaid(again.id, { paidOn: ymd(now.getTime()), method: "check" }, new Date(), ws)).toMatchObject({ ok: true });
    await mirror();
    expect(mine().find((s) => s.desk_statement_id === again.id)).toMatchObject({ state: "paid", paid_method: "Check", paid_on: ymd(now.getTime()) });
  });

  test("another fleet's rows are never touched, and an unlinked driver's all go with their PDFs", async () => {
    t.statements.push({ ...mine()[0]!, id: "other", org_id: "another_org" });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: null } });
    await mirror();
    expect(mine().map((s) => s.org_id)).toEqual(["another_org"]);
    expect(t.balances.find((b) => b.driver_sub === PHONE)).toBeUndefined();
    expect([...t.files.keys()].filter((k) => k.includes(PHONE))).toEqual([]);
  });

  test("a fleet not on the bridge writes nothing", async () => {
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: null } });
    expect(await mirrorDriverPay(memoryTransport(), { workspaceId: ws })).toEqual({ statements: 0, removed: 0, balances: 0, failed: 0 });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
  });
});
