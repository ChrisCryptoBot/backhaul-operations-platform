import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { parseCsv } from "@/lib/import-csv";
import { LEAKS } from "@/lib/leaks";
import { commitIftaRates } from "@/server/partners/ifta-rates";
import { fileIftaReturn } from "@/server/partners/ifta-filing";
import { buildExport } from "@/server/tl/exports";
import { clearLeakCache, getLeakLedger } from "@/server/tl/leaks";

/**
 * Money plan Wave 6 step 3: the Leak ledger's partner lines from stored records, in a workspace of its own. Factoring fees by funding day (an invoice with a fee taken short too is priced once),
 * a quick-pay fee taken short, a chargeback shown and not added, fuel bought with no card discount counted and not priced, and a filed IFTA return above its recalculation on final rates. Scoped
 * to a terminal, an invoice of loads elsewhere, fuel on no truck and the IFTA return are left out and counted as the whole fleet's. The CSV carries the screen's lines row for row.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/leaks-partner.integration.test.ts
 */
const W = "lkp-w";
const state = { terminal: null as string | null };
vi.mock("@/server/tl/workspace", async (orig) => ({ ...(await orig<typeof import("@/server/tl/workspace")>()), currentWorkspaceId: () => W }));
vi.mock("@/server/tl/terminal", () => ({ currentTerminal: async () => state.terminal }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const D = (s: string) => new Prisma.Decimal(s);

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

let seq = 0;
const ledger = async (terminals: string[] | null = null) => {
  clearLeakCache();
  return getLeakLedger({ period: "4w", compare: false, terminals }, NOW, W);
};
const line = (l: Awaited<ReturnType<typeof ledger>>, key: string) => {
  const x = l.current.lines.find((y) => y.key === key)!;
  return { dollars: x.dollars, items: x.items, unpriced: x.unpriced };
};

describe.skipIf(!run)("Leak ledger: partner records", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: W, plan: "enterprise", timezone: "America/Chicago" } as never });
    const dallas = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 801", terminal: "Dallas" } })).id;
    const memphis = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 802", terminal: "Memphis" } })).id;
    // Loads finished long before the window: they carry no leaks of their own, only the invoices below.
    const load = async (n: string, vehicleId: string) => (await prisma.load.create({ data: { workspaceId: W, vehicleId, loadNumber: n, status: "completed", completedAt: ago(300), quotedRevenue: 1000, originAddress: "Dallas, TX", destinationAddress: "Memphis, TN" } as never })).id;
    const inv = async (number: string, loadIds: string[], data: Record<string, unknown>, payments: Array<[string, Date]> = []) =>
      prisma.invoice.create({
        data: {
          workspaceId: W,
          number,
          kind: "invoice",
          billToName: "Acme Logistics",
          issuedAt: ago(40),
          total: D("1000.00"),
          ...data,
          lines: { create: loadIds.map((loadId, k) => ({ loadId, kind: "linehaul", label: "Line haul", amount: D((1000 / loadIds.length).toFixed(2)), sort: k })) },
          loads: { create: loadIds.map((loadId) => ({ loadId })) },
          payments: { create: payments.map(([a, at]) => ({ workspaceId: W, amount: D(a), paidAt: at, source: "desk" })) }
        } as never
      });
    const [la, lb, lc, ld1, ld2, le, lv, lo] = await Promise.all([load("L-A", dallas), load("L-B", memphis), load("L-C", dallas), load("L-D1", dallas), load("L-D2", memphis), load("L-E", dallas), load("L-V", dallas), load("L-O", dallas)]);
    await inv("INV-A", [la], { factoringStatus: "funded", factoringFundedAt: ago(2), factoringFee: D("25.00") });
    await inv("INV-B", [lb], { status: "paid", paidAt: ago(1), writeOffAmount: D("20.00"), writeOffCode: "quick_pay_fee", paidTotal: D("980.00") });
    await inv("INV-C", [lc], { status: "paid", factoringStatus: "paid", factoringFundedAt: ago(3), factoringFee: D("30.00"), paidAt: ago(1), writeOffAmount: D("30.00"), writeOffCode: "factor_fee" }); // both: once
    await inv("INV-D", [ld1, ld2], { factoringStatus: "funded", factoringFundedAt: ago(2), factoringFee: D("40.00") }); // two terminals: the whole fleet's
    await inv("INV-E", [le], { factoringStatus: "rejected", factoringFundedAt: ago(20), factoringChargeback: D("900.00"), factoringChargedBackAt: ago(5) }, [["400.00", ago(1)]]);
    await inv("INV-V", [lv], { status: "void", factoringFundedAt: ago(2), factoringFee: D("99.00") }); // void: never
    await inv("INV-O", [lo], { factoringStatus: "funded", factoringFundedAt: ago(200), factoringFee: D("50.00") }); // before the window

    const fuel = (vehicleId: string | null, over: Record<string, unknown>, at = ago(2)) =>
      prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "wex", externalId: `f-${++seq}`, vehicleId, purchaseState: "TX", location: `Stop ${seq}, TX`, product: "road_diesel", status: "settled", taxPaid: true, gallons: 100, pricePerGallon: 3.5, amount: 350, postedAt: at, purchasedAt: at, ...over } as never });
    await fuel(dallas, { discount: D("0") });
    await fuel(memphis, { discountPerGallon: D("0") });
    await fuel(null, { discount: D("0") });
    await fuel(dallas, {}); // the source said nothing: not counted
    await fuel(dallas, { discount: D("5.00") }); // a discount was given
    await fuel(dallas, { discount: D("0"), status: "declined" }); // not settled

    // The IFTA quarter: 1,000 miles each in Texas ($0.20) and Oklahoma ($0.40), 200 bulk gallons (no tax at the pump): 100 taxable gallons each, filed at $60.00. A receipt that arrives
    // after filing (100 gallons, tax paid in Oklahoma) brings the recalculation to $50.00: filed $10.00 high. Rates of a filed quarter are locked, so only late data moves it.
    const mi = (j: string, n: number) => ({ workspaceId: W, vehicleId: dallas, quarter: Q, jurisdiction: j, source: "promiles", method: "routed", externalId: `r-${n}`, loaded: true, miles: 1000, startedAt: new Date(`2026-08-0${n}T10:00:00Z`), endedAt: new Date(`2026-08-0${n}T20:00:00Z`), syncBatchId: "b", syncedAt: NOW });
    await prisma.iftaMileage.createMany({ data: [mi("TX", 1), mi("OK", 2)] as never });
    await fuel(dallas, { taxPaid: false, gallons: 200, amount: 700 }, new Date("2026-08-02T12:00:00Z"));
    expect(await commitIftaRates("Jurisdiction,Diesel,Surcharge\nTexas,0.20,\nOklahoma,0.40,", null, Q, "final", "q3.csv", ago(3), W)).toMatchObject({ ok: true });
    const filedOut = await fileIftaReturn(Q, {}, ago(1), W);
    if (!filedOut.ok) throw new Error(JSON.stringify(filedOut));
    expect((await prisma.iftaReturn.findFirstOrThrow({ where: { workspaceId: W, quarter: Q, status: "filed" } })).total.toFixed(2)).toBe("60.00");
    await fuel(dallas, { purchaseState: "OK", location: "Late receipt, OK" }, new Date("2026-08-03T12:00:00Z"));
  });
  afterAll(wipe);

  test("the whole fleet: each partner line from its stored records, one invoice priced once, nothing estimated", async () => {
    const l = await ledger();
    expect(line(l, "factoring_fees")).toEqual({ dollars: 95, items: 3, unpriced: 0 }); // A 25 + C 30 + D 40
    expect(line(l, "fee_short_pays")).toEqual({ dollars: 20, items: 1, unpriced: 0 }); // B; C's fee taken short is not counted again
    expect(line(l, "fuel_no_discount")).toEqual({ dollars: 0, items: 3, unpriced: 3 });
    expect(line(l, "ifta_overpaid")).toEqual({ dollars: 10, items: 1, unpriced: 0 });
    expect(line(l, "factor_chargebacks")).toEqual({ dollars: 900, items: 1, unpriced: 0 });
    expect(l.current.money).toEqual({ dollars: 125, items: 8, unpriced: 3 });
    expect(l.current.total).toBe(125);
    expect(l.fleetOnly).toEqual({ items: 0, byKey: {} });
    const e = l.top.find((t) => t.label === "INV-E");
    expect(e).toBeUndefined(); // a lens item is never one of the top items
    const top = l.top.filter((t) => t.partner || t.key === "fee_short_pays").map((t) => [t.key, t.label, t.dollars, t.href]);
    expect(top).toEqual(
      expect.arrayContaining([
        ["factoring_fees", "INV-D", 40, expect.stringMatching(/^\/invoices\//)],
        ["factoring_fees", "INV-C", 30, expect.stringMatching(/^\/invoices\//)],
        ["factoring_fees", "INV-A", 25, expect.stringMatching(/^\/invoices\//)],
        ["fee_short_pays", "INV-B", 20, expect.stringMatching(/^\/invoices\//)],
        ["ifta_overpaid", "2026-Q3 IFTA return", 10, "/ifta?quarter=2026-Q3"]
      ])
    );
    expect(top).toHaveLength(5);
  });

  test("a terminal in view: its own invoices and fuel only; the fleet's records are counted apart, never shown as the terminal's", async () => {
    const d = await ledger(["Dallas"]);
    expect([line(d, "factoring_fees"), line(d, "fee_short_pays"), line(d, "fuel_no_discount"), line(d, "ifta_overpaid"), line(d, "factor_chargebacks")]).toEqual([
      { dollars: 55, items: 2, unpriced: 0 },
      { dollars: 0, items: 0, unpriced: 0 },
      { dollars: 0, items: 1, unpriced: 1 },
      { dollars: 0, items: 0, unpriced: 0 },
      { dollars: 900, items: 1, unpriced: 0 }
    ]);
    expect(d.fleetOnly).toEqual({ items: 3, byKey: { factoring_fees: 1, fuel_no_discount: 1, ifta_overpaid: 1 } });
    const m = await ledger(["Memphis"]);
    expect([line(m, "factoring_fees").dollars, line(m, "fee_short_pays").dollars, line(m, "fuel_no_discount").items, line(m, "factor_chargebacks").items]).toEqual([0, 20, 1, 0]);
    expect(m.fleetOnly.items).toBe(3);
  });

  test("the leaks CSV is the screen's lines, row for row, and says each partner line rests on a partner record", async () => {
    for (const terminal of [null, "Dallas"]) {
      state.terminal = terminal;
      const l = await ledger(terminal ? [terminal] : null);
      clearLeakCache();
      const out = await buildExport("leaks", { period: "4w" }, NOW);
      const [head, ...rows] = parseCsv(out!.csv);
      expect(head).toEqual(["Leak", "Dollars", "Items", "Items not priced", "Empty miles not priced", "Counted in the total", "Priced from", "Basis"]);
      expect(rows.map((r) => r[0])).toEqual(LEAKS.map((m) => m.label));
      for (const x of l.current.lines) {
        const r = rows.find((y) => y[0] === x.label)!;
        expect([Number.parseFloat(r[1]!), Number.parseInt(r[2]!, 10), Number.parseInt(r[3]!, 10), r[5], r[7]]).toEqual([x.dollars, x.items, x.unpriced, x.counted ? "yes" : "no", x.basis]);
      }
      for (const k of ["factoring_fees", "fuel_no_discount", "ifta_overpaid", "factor_chargebacks"]) expect(rows.find((y) => y[0] === LEAKS.find((m) => m.key === k)!.label)![6]).toMatch(/^a partner record/);
      const items = parseCsv((await buildExport("leaks-items", { period: "4w" }, NOW))!.csv).slice(1);
      expect(items.map((r) => [r[2], Number.parseFloat(r[8]!)])).toEqual(l.top.map((t) => [t.label, t.dollars]));
    }
    state.terminal = null;
  });
});
