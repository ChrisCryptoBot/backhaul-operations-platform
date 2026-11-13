import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { cashFileRows } from "@/lib/cash";
import { parseCsv } from "@/lib/import-csv";
import { clearCashCache, getCashMoves, getKpiCash } from "@/server/tl/cash";
import { buildExport } from "@/server/tl/exports";

/**
 * Money plan Wave 6 step 4: cash beside gross from stored records, in a workspace of its own. A plain invoice paid, a factored one funded and released (the customer's payment to the factor not
 * counted again), one charged back, one of two loads in two terminals (left out of a terminal's view, never split), a quick-pay fee taken short, and one still open. Then the terminals and
 * filters, the file against the card's figures, and Why it moved's cash bridge adding back to the cent.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/cash.integration.test.ts
 */
const W = "cash-w";
const state = { terminal: null as string | null };
vi.mock("@/server/tl/workspace", async (orig) => ({ ...(await orig<typeof import("@/server/tl/workspace")>()), currentWorkspaceId: () => W }));
vi.mock("@/server/tl/terminal", () => ({ currentTerminal: async () => state.terminal }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const NOW = new Date("2026-11-13T15:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const D = (s: string) => new Prisma.Decimal(s);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("cash beside gross", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise", timezone: "America/Chicago" } as never });
    const dallas = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 801", terminal: "Dallas" } })).id;
    const memphis = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 802", terminal: "Memphis" } })).id;
    const load = async (n: string, vehicleId: string, broker = "Acme Logistics") =>
      (await prisma.load.create({ data: { workspaceId: W, vehicleId, loadNumber: n, brokerName: broker, status: "completed", completedAt: ago(15), quotedRevenue: 1000, originAddress: "Dallas, TX", destinationAddress: "Memphis, TN" } as never })).id;
    const inv = (number: string, loadIds: string[], issued: number, data: Record<string, unknown>, payments: Array<[string, number, string?]> = []) =>
      prisma.invoice.create({
        data: {
          workspaceId: W,
          number,
          kind: "invoice",
          billToName: "Acme Logistics",
          issuedAt: ago(issued),
          total: D("1000.00"),
          ...data,
          lines: { create: loadIds.map((loadId, k) => ({ loadId, kind: "linehaul", label: "Line haul", amount: D((1000 / loadIds.length).toFixed(2)), sort: k })) },
          loads: { create: loadIds.map((loadId) => ({ loadId })) },
          payments: { create: payments.map(([a, d, source]) => ({ workspaceId: W, amount: D(a), paidAt: ago(d), source: source ?? "desk" })) }
        } as never
      });
    const [la, lf, lc, lm1, lm2, lq, lo] = await Promise.all([load("C-A", dallas), load("C-F", dallas), load("C-C", memphis), load("C-M1", dallas), load("C-M2", memphis), load("C-Q", memphis, "Bolt Freight"), load("C-O", dallas)]);
    await inv("CI-A", [la], 10, { status: "paid", paidTotal: D("1000.00"), paidAt: ago(3) }, [["1000.00", 3]]);
    await inv("CI-F", [lf], 12, { status: "paid", paidTotal: D("1000.00"), paidAt: ago(2), factoringStatus: "paid", factoringFundedAt: ago(8), factoringAdvance: D("900.00"), factoringFee: D("25.00"), factoringReserve: D("100.00"), factoringReserveReleased: D("75.00"), factoringReserveReleasedAt: ago(2) }, [["1000.00", 2, "factor"]]);
    await inv("CI-C", [lc], 22, { factoringStatus: "rejected", factoringFundedAt: ago(20), factoringAdvance: D("900.00"), factoringChargeback: D("900.00"), factoringChargedBackAt: ago(5) });
    await inv("CI-M", [lm1, lm2], 9, { paidTotal: D("500.00") }, [["500.00", 4]]);
    await inv("CI-Q", [lq], 7, { status: "paid", paidTotal: D("980.00"), paidAt: ago(1), writeOffAmount: D("20.00"), writeOffCode: "quick_pay_fee" }, [["980.00", 1]]);
    await inv("CI-O", [lo], 6, {});
    await inv("CI-V", [lo], 6, { status: "void", paidTotal: D("1000.00") }, [["1000.00", 1]]); // void: never cash
  });
  afterAll(wipe);

  const cash = (q: { terminals?: string[] | null; filters?: Record<string, string> } = {}) => {
    clearCashCache();
    return getKpiCash({ period: "4w", compare: false, filters: q.filters, terminals: q.terminals ?? null }, NOW, W);
  };

  test("the whole fleet: cash in by source, cost of money, what is owed, days to cash", async () => {
    const k = await cash();
    expect(k.current.cash).toEqual({ customer: 248000, advance: 180000, released: 7500, chargeback: -90000, net: 345500 });
    expect(k.current.cost).toEqual({ feesCents: 2500, shortCents: 2000, items: 2 });
    expect(k.open).toEqual({ cents: 250000, invoices: 3, factoredCents: 0, factoredInvoices: 0 });
    expect(k.leftOut).toBe(0);
    // Issued in the window: six. First cash reached by five (O has none); paid in full by three (A, F on its release, Q).
    expect(k.current.days.invoices).toBe(6);
    // Issued to first cash: C 2, F 4, M 5, Q 6, A 7 days.
    expect(k.current.days.firstCash).toEqual({ reached: 5, waiting: 1, median: 5, p90: 7 });
    expect(k.current.days.paidInFull).toEqual({ reached: 3, waiting: 3, median: 7, p90: 10 });
  });

  test("a terminal in view: its own invoices; one whose loads span terminals is left out and counted, never split", async () => {
    const d = await cash({ terminals: ["Dallas"] });
    expect(d.current.cash).toEqual({ customer: 100000, advance: 90000, released: 7500, chargeback: 0, net: 197500 });
    expect([d.leftOut, d.open.invoices, d.current.cost.feesCents, d.current.cost.shortCents]).toEqual([1, 1, 2500, 0]);
    const m = await cash({ terminals: ["Memphis"] });
    expect(m.current.cash).toEqual({ customer: 98000, advance: 90000, released: 0, chargeback: -90000, net: 98000 });
    expect(m.leftOut).toBe(1);
  });

  test("the dashboard's filters, read off the loads the way the KPI reads them", async () => {
    const b = await cash({ filters: { broker: "Bolt Freight" } });
    // CI-M's two loads are both Acme's: wholly out of a Bolt view, so not left out (only a mixed invoice is).
    expect([b.current.cash.net, b.current.cost.shortCents, b.leftOut]).toEqual([98000, 2000, 0]);
    const t = await cash({ filters: { truck: "Unit 801" } });
    expect([t.current.cash.customer, t.current.cash.advance, t.leftOut]).toEqual([100000, 90000, 1]);
  });

  test("the file is the card's figures, row for row", async () => {
    for (const terminal of [null, "Dallas"]) {
      state.terminal = terminal;
      const k = await cash({ terminals: terminal ? [terminal] : null });
      clearCashCache();
      const out = await buildExport("kpi-cash", { period: "4w", compare: "off" }, NOW);
      const [head, ...rows] = parseCsv(out!.csv);
      expect(head).toEqual(["Group", "Measure", "Unit", "This period", "The period before"]);
      expect(rows).toEqual(cashFileRows(k).map((r) => [r.group, r.measure, r.unit, r.now == null ? "" : String(r.now), r.before == null ? "" : String(r.before)]));
    }
    state.terminal = null;
  });

  test("why it moved: this week's cash against last week's, by source and by lane, adding back to the cent", async () => {
    clearCashCache();
    const m = await getCashMoves({ ago: 0, by: "customer", terminals: null }, NOW, W);
    expect(m.bridge.before).toEqual({ customer: 0, advance: 90000, released: 0, chargeback: 0, net: 90000 });
    expect(m.bridge.after).toEqual({ customer: 248000, advance: 0, released: 7500, chargeback: -90000, net: 165500 });
    expect(m.bridge.change).toBe(75500);
    expect(m.bridge.effects.reduce((s, e) => s + e.cents, 0)).toBe(m.bridge.change);
    expect(m.rows.reduce((s, r) => s + r.change, 0)).toBe(m.bridge.change);
    expect(m.rows.map((r) => r.name)).toEqual(["Acme Logistics"]);
    expect(m.days.after.reached).toBe(3);
    clearCashCache();
    const lane = await getCashMoves({ ago: 0, by: "lane", terminals: null }, NOW, W);
    expect(lane.rows.map((r) => [r.name, r.change])).toEqual([["Dallas, TX → Memphis, TN", 25500], ["Several lanes", 50000]].sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number)));
    clearCashCache();
    const dal = await getCashMoves({ ago: 0, by: "lane", terminals: ["Dallas"] }, NOW, W);
    expect([dal.bridge.change, dal.leftOut]).toEqual([107500 - 90000, 1]);
  });
});
