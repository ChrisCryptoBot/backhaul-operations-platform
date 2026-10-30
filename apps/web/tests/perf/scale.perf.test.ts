import { beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { getAlerts, clearAlertCache } from "@/server/tl/alerts";
import { listAudit } from "@/server/tl/audit";
import { getDetentionRecovery } from "@/server/tl/detention";
import { listDriversPage, listTrucksPage } from "@/server/tl/fleet-list";
import { listHistory } from "@/server/tl/history";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { getPlannerData } from "@/server/tl/planner";
import { agingFor, countInvoices, listBoardRows, listInvoiceRows } from "@/server/tl/queries";
import { fitQuote } from "@/server/tl/quote";
import { listSettlements, settlementCounts, unsettledByDriver } from "@/server/tl/settlement";
import { getShellData } from "@/server/tl/shell";

/**
 * How long each screen's data takes on the scale database: 1,500 trucks and drivers, 50,000 loads, 100,000 stops, about 9,000 invoices out. Not run with the rest.
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf
 *
 * The budgets are about twice what a warm run measured on a developer's laptop (docs/DEMO_REBUILD.md keeps the numbers), so they catch a screen that goes back to reading
 * the whole fleet, not noise. Each is the best of two runs. A screen adds its own rendering to these, so the browser is the last word; the screens that add up the whole
 * fleet (the header's alerts, the KPI) are built once and kept until the data moves, so they have a first-visit budget and a kept one.
 */
const run = process.env.RUN_SCALE === "true";

async function best(fn: () => Promise<unknown>, runs = 2): Promise<number> {
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    await fn();
    fastest = Math.min(fastest, Date.now() - t);
  }
  return fastest;
}

const offer = () => {
  const input = readQuote({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup" as const, address: "Dallas, TX", appointment: "2027-02-09T08:00" },
      { role: "delivery" as const, address: "Tulsa, OK", appointment: "2027-02-09T17:00" }
    ],
    broker: "Customer 01",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500"
  });
  if (!input) throw new Error("not priceable");
  return input;
};

describe.runIf(run)("the desk at the size of a big fleet", () => {
  beforeAll(async () => {
    const trucks = await prisma.vehicle.count();
    if (trucks < 1000) throw new Error(`RUN_SCALE needs the scale database (demo_scale, seeded by scripts/seed-scale.ts); this one has ${trucks} trucks.`);
    clearKpiCache();
    clearAlertCache();
  });

  test("the header and the alerts: built once, then a check of the data", async () => {
    const first = await best(() => getShellData(), 1);
    expect(first).toBeLessThan(6_000);
    expect(await best(() => getShellData())).toBeLessThan(400);
    expect(await best(() => getAlerts(new Date(), undefined, "all"))).toBeLessThan(400);
  }, 60_000);

  test("pricing an offer for 1,500 trucks shows the best 50 in about a second", async () => {
    const input = offer();
    expect(await best(() => fitQuote(input))).toBeLessThan(1_500);
    const fit = await fitQuote(input);
    expect(fit.rows.length).toBeLessThanOrEqual(50);
    expect(fit.total).toBeGreaterThan(1000);
  }, 60_000);

  test("the lists read a page at a time", async () => {
    expect(await best(() => listTrucksPage({}))).toBeLessThan(400);
    expect(await best(() => listDriversPage({}))).toBeLessThan(400);
    expect(await best(() => listTrucksPage({ q: "Unit 12" }))).toBeLessThan(500);
    expect(await best(() => listAudit({}))).toBeLessThan(400);
    expect(await best(() => listSettlements(undefined, { take: 50 }))).toBeLessThan(400);
  }, 60_000);

  test("Loads: the open board and History", async () => {
    expect(await best(() => listBoardRows())).toBeLessThan(1_200);
    expect(await best(() => listHistory({}))).toBeLessThan(500);
    expect(await best(() => listHistory({ q: "SC-4412" }))).toBeLessThan(600);
    expect(await best(() => listHistory({ filter: "owed", sort: "pay" }))).toBeLessThan(800);
  }, 60_000);

  test("the planner reads the days shown, not the history", async () => {
    expect(await best(() => getPlannerData(Date.now()))).toBeLessThan(1_500);
  }, 60_000);

  test("Invoices: each list a page at a time, the money out from plain columns", async () => {
    expect(await best(() => listInvoiceRows(undefined, { scope: "ready", take: 25 }))).toBeLessThan(500);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50 }))).toBeLessThan(500);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50, q: "Customer 07" }))).toBeLessThan(800);
    expect(await best(() => listInvoiceRows(undefined, { scope: "paid", take: 50 }))).toBeLessThan(600);
    expect(await best(() => Promise.all([countInvoices("ready"), countInvoices("out"), countInvoices("paid")]))).toBeLessThan(300);
    expect(await best(() => agingFor())).toBeLessThan(400);
    expect(await best(() => getDetentionRecovery())).toBeLessThan(1_500);
  }, 60_000);

  test("Settlements: pay owed is added up from plain columns", async () => {
    expect(await best(() => settlementCounts())).toBeLessThan(300);
    expect(await best(() => unsettledByDriver())).toBeLessThan(1_500);
  }, 60_000);

  test("KPI, Customers and Lanes: built once, then kept until the data moves", async () => {
    expect(await best(() => getDeskKpi({ period: "4w", compare: true }), 1)).toBeLessThan(12_000);
    expect(await best(() => getDeskKpi({ period: "4w", compare: true }))).toBeLessThan(300);
    expect(await best(() => getDeskKpi({ period: "all", compare: false }), 1)).toBeLessThan(20_000);
    expect(await best(() => getDeskKpi({ period: "all", compare: false }))).toBeLessThan(300);
  }, 120_000);
});
