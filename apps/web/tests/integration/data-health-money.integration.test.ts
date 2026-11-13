import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/import-csv";
import { MONEY_CHECKS } from "@/lib/money-integrity";
import { clearHealthCache, getDataHealth } from "@/server/tl/data-health";
import { buildExport } from "@/server/tl/exports";

/**
 * Wave 6 step 2: Data health's money checks on stored records. A workspace of its own seeded with one clean record of each kind and at least one failure of every check (a total that is not its
 * lines, more received than billed, a load whose money drifted from its invoice, a cancelled load on a final statement, one fuel purchase on two statements, an invoice QuickBooks never got and
 * a void it never carried across, a funded invoice with no advance), then the card's read and the CSV compared row by row. QuickBooks disconnected, its check says "not checked".
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/data-health-money.integration.test.ts
 */
const W = "dhmoney-w";
vi.mock("@/server/tl/workspace", async (orig) => ({ ...(await orig<typeof import("@/server/tl/workspace")>()), currentWorkspaceId: () => W }));
vi.mock("@/server/tl/terminal", () => ({ currentTerminal: async () => null }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const NOW = new Date("2026-11-13T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SYNCED = ago(2);
const D = (s: string) => new Prisma.Decimal(s);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

const loads: Record<string, string> = {};
async function mkLoad(n: string, o: Record<string, unknown> = {}) {
  const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: n, brokerName: "Acme Logistics", status: "completed", completedAt: ago(48), quotedRevenue: 1000, ...o } as never });
  loads[n] = l.id;
  return l.id;
}
type InvSeed = { number: string; total: string; lines: Array<[string | null, string]>; loads: string[]; payments?: string[]; status?: string; paidTotal?: string; createdAt?: Date; voidedAt?: Date; inQbo?: boolean; factoring?: Record<string, unknown> };
async function mkInv(s: InvSeed) {
  const i = await prisma.invoice.create({
    data: {
      workspaceId: W,
      number: s.number,
      kind: "invoice",
      status: s.status ?? "open",
      billToName: "Acme Logistics",
      issuedAt: ago(30),
      termsDays: 30,
      total: D(s.total),
      paidTotal: D(s.paidTotal ?? "0"),
      createdAt: s.createdAt ?? ago(30),
      voidedAt: s.voidedAt ?? null,
      ...(s.factoring ?? {}),
      lines: { create: s.lines.map(([n, amount], k) => ({ loadId: n ? loads[n]! : null, kind: "linehaul", label: "Line haul", amount: D(amount), sort: k })) },
      loads: { create: s.loads.map((n) => ({ loadId: loads[n]! })) },
      payments: { create: (s.payments ?? []).map((a) => ({ workspaceId: W, amount: D(a), paidAt: ago(10), source: "desk" })) }
    }
  });
  if (s.inQbo !== false) await prisma.externalRef.create({ data: { workspaceId: W, provider: "quickbooks", entity: "invoice", localId: i.id, externalId: `qbo-${s.number}`, syncedAt: SYNCED } });
  return i;
}

const health = async (terminals: string[] | null = null) => {
  clearHealthCache();
  return (await getDataHealth({ period: "all", terminals }, NOW, W)).money;
};
const csvMoney = async () => {
  clearHealthCache();
  const out = await buildExport("data-health-checks", { period: "all" }, NOW);
  const [head, ...rows] = parseCsv(out!.csv);
  expect(head).toEqual(["Check", "Measure", "Loads", "Dollars"]);
  return rows.filter((r) => r[0]!.startsWith("Money: "));
};

describe.skipIf(!run)("Data health: money records agree", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise", timezone: "America/Chicago" } as never });
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Sam Owner", payrollWorkerType: "contractor" } as never });

    // Invoices: one clean, and one failure for each invoice-side check.
    await mkLoad("L-OK", { paymentStatus: "invoiced", invoicedAmount: D("1000") });
    await mkInv({ number: "I-OK", total: "1000.00", lines: [["L-OK", "1000.00"]], loads: ["L-OK"] });
    await mkLoad("L-LINES", { paymentStatus: "invoiced", invoicedAmount: D("900") });
    await mkInv({ number: "I-LINES", total: "1000.00", lines: [["L-LINES", "900.00"]], loads: ["L-LINES"] }); // lines 900, total 1000
    await mkLoad("L-OVER", { paymentStatus: "paid", invoicedAmount: D("1000"), paidAmount: D("1100") });
    await mkInv({ number: "I-OVER", total: "1000.00", lines: [["L-OVER", "1000.00"]], loads: ["L-OVER"], payments: ["600.00", "500.00"], status: "paid", paidTotal: "1100.00" }); // 1,100 on 1,000
    await mkLoad("L-PROJ", { paymentStatus: "invoiced", invoicedAmount: D("800") });
    await mkInv({ number: "I-PROJ", total: "1000.00", lines: [["L-PROJ", "1000.00"]], loads: ["L-PROJ"] }); // the load says 800
    await mkLoad("L-MISS", { paymentStatus: "invoiced", invoicedAmount: D("1000") });
    await mkInv({ number: "I-MISS", total: "1000.00", lines: [["L-MISS", "1000.00"]], loads: ["L-MISS"], inQbo: false }); // never reached QuickBooks
    await mkLoad("L-VOID");
    await mkInv({ number: "I-VOID", total: "1000.00", lines: [["L-VOID", "1000.00"]], loads: ["L-VOID"], status: "void", voidedAt: ago(5) }); // void before the sync, still in QuickBooks
    await mkLoad("L-NEW", { paymentStatus: "invoiced", invoicedAmount: D("1000") });
    await mkInv({ number: "I-NEW", total: "1000.00", lines: [["L-NEW", "1000.00"]], loads: ["L-NEW"], createdAt: ago(1), inQbo: false }); // made after the last sync: not yet due in QuickBooks
    await mkLoad("L-FAC", { paymentStatus: "invoiced", invoicedAmount: D("1000"), factoringStatus: "funded" });
    await mkInv({ number: "I-FAC", total: "1000.00", lines: [["L-FAC", "1000.00"]], loads: ["L-FAC"], factoring: { factoringStatus: "funded", factoringFundedAt: ago(20) } }); // funded, no advance

    // Statements: ST-1 holds a good load and one cancelled since; fuel F-1 is on both ST-1 and ST-2, F-2 on ST-2 only.
    const stOf = (number: string) =>
      prisma.settlement.create({ data: { workspaceId: W, driverId: driver.id, number, status: "final", periodStart: ago(200), periodEnd: ago(100), total: D("1500.00"), fuel: [] as never, finalizedAt: ago(90) } as never });
    const st1 = await stOf("ST-1");
    const st2 = await stOf("ST-2");
    await mkLoad("L-ST");
    await mkLoad("L-CAN", { status: "cancelled" });
    await prisma.settlementLoad.createMany({ data: [{ settlementId: st1.id, loadId: loads["L-ST"]!, amount: D("1000") }, { settlementId: st1.id, loadId: loads["L-CAN"]!, amount: D("500") }] });
    const fuel = (ext: string, settlementId: string) => prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "csv", externalId: ext, product: "road_diesel", status: "settled", taxPaid: true, gallons: 100, pricePerGallon: 3.5, amount: 350, postedAt: ago(120), settlementId } as never });
    const f1 = await fuel("F-1", st1.id);
    const f2 = await fuel("F-2", st2.id);
    await prisma.settlementLine.createMany({
      data: [
        { workspaceId: W, settlementId: st1.id, sort: 1, kind: "fuel", label: "Fuel F-1", amount: D("-350"), fuelTransactionId: f1.id },
        { workspaceId: W, settlementId: st2.id, sort: 1, kind: "fuel", label: "Fuel F-1", amount: D("-350"), fuelTransactionId: f1.id },
        { workspaceId: W, settlementId: st2.id, sort: 2, kind: "fuel", label: "Fuel F-2", amount: D("-350"), fuelTransactionId: f2.id }
      ] as never
    });

    // QuickBooks connected, its last sync finished two hours ago.
    await prisma.partnerConnection.create({ data: { workspaceId: W, capability: "accounting", provider: "quickbooks", status: "connected", connectedAt: ago(500) } });
    await prisma.syncCursor.create({ data: { workspaceId: W, provider: "quickbooks", stream: "changes", cursor: SYNCED.toISOString(), lastRunAt: SYNCED, lastOkAt: SYNCED } });
  });
  afterAll(wipe);

  test("every check runs and names its failures", async () => {
    const m = await health();
    const by = Object.fromEntries(m.checks.map((c) => [c.key, c]));
    const shape = (k: string) => [by[k]!.state, by[k]!.checked, by[k]!.passed, by[k]!.failed, by[k]!.examples.map((e) => e.label)];
    expect(shape("invoice_lines_total")).toEqual(["checked", 7, 6, 1, ["I-LINES"]]);
    expect(shape("payments_over_total")).toEqual(["checked", 7, 6, 1, ["I-OVER"]]);
    expect(shape("load_projection")).toEqual(["checked", 7, 6, 1, ["I-PROJ"]]);
    expect(shape("settled_load_voided")).toEqual(["checked", 3, 2, 1, ["L-CAN"]]);
    expect(shape("fuel_deducted_twice")).toEqual(["checked", 2, 1, 1, ["Fuel F-1"]]);
    expect(shape("qbo_mismatch")).toEqual(["checked", 7, 5, 2, ["I-MISS", "I-VOID"]]);
    expect(shape("factor_mismatch")).toEqual(["checked", 1, 0, 1, ["I-FAC"]]);
    expect(by.payments_over_total!.examples[0]!.detail).toBe("received and credited $1,100.00 on $1,000.00");
    expect(by.load_projection!.examples[0]!.detail).toBe("load L-PROJ invoiced $800.00, its lines $1,000.00");
    expect(by.fuel_deducted_twice!.examples[0]!.detail).toBe("taken off ST-1 and ST-2");
    expect(by.factor_mismatch!.examples[0]!.detail).toBe("funded, with no advance recorded");
    expect(by.settled_load_voided!.examples[0]!.href).toMatch(/^\/settlements\//);
    expect([m.failed, m.notChecked, m.truncated]).toEqual([8, 0, false]);
  });

  test("money is the whole fleet's whatever terminals are in view", async () => {
    expect(await health(["Dallas"])).toEqual(await health());
  });

  test("the CSV carries the card's figures, row for row", async () => {
    const m = await health();
    const rows = await csvMoney();
    expect(rows).toEqual(
      m.checks.flatMap((c) => [
        [`Money: ${c.label}`, "Records checked", String(c.checked), ""],
        [`Money: ${c.label}`, "Agree", String(c.passed), ""],
        [`Money: ${c.label}`, "Disagree", String(c.failed), ""]
      ])
    );
    expect(rows.map((r) => r[0])).toEqual(MONEY_CHECKS.flatMap((c) => Array(3).fill(`Money: ${c.label}`)));
  });

  test("QuickBooks disconnected: its check says not checked, on the card and in the CSV, and counts nothing", async () => {
    await prisma.partnerConnection.updateMany({ where: { workspaceId: W }, data: { status: "disconnected" } });
    const q = (await health()).checks.find((c) => c.key === "qbo_mismatch")!;
    expect(q).toMatchObject({ state: "not_checked", notCheckedWhy: "QuickBooks is not connected.", checked: 0, passed: 0, failed: 0, examples: [] });
    expect((await csvMoney()).filter((r) => r[0] === "Money: QuickBooks holds what the desk holds")).toEqual([["Money: QuickBooks holds what the desk holds", "Not checked: QuickBooks is not connected.", "", ""]]);
    expect((await health()).notChecked).toBe(1);
    await prisma.partnerConnection.updateMany({ where: { workspaceId: W }, data: { status: "connected" } });
  });
});
