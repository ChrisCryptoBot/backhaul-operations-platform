import { beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { listPayroll } from "@/server/partners/payroll";
import { agingSummary, clearAgingCache } from "@/server/tl/aging";
import { clearAlertCache, getAlerts } from "@/server/tl/alerts";
import { listAudit } from "@/server/tl/audit";
import { countDeletedLoads, listDeletedLoads } from "@/server/tl/deleted";
import { getDetentionRecovery } from "@/server/tl/detention";
import { buildExport } from "@/server/tl/exports";
import { listDriversPage, listTrucksPage } from "@/server/tl/fleet-list";
import { listHistory } from "@/server/tl/history";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { getPlannerData } from "@/server/tl/planner";
import { readRadarParams } from "@/lib/radar-points";
import { getRadarData } from "@/server/tl/radar";
import { unitsNear } from "@/server/tl/radar-near";
import { radarList, radarPoints } from "@/server/tl/radar-query";
import { agingFor, countInvoices, listBoardRows, listInvoiceRows } from "@/server/tl/queries";
import { fitQuote } from "@/server/tl/quote";
import { kpiChoices } from "@/server/tl/kpi-choices";
import { listCustomerRecordsInScope } from "@/server/tl/customers";
import { listSettlements, settlementCounts, unsettledByDriver } from "@/server/tl/settlement";
import { getShellData } from "@/server/tl/shell";
import { countTrailersAvailable, listTrailersPage } from "@/server/tl/trailers";

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
    clearAgingCache();
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

  test("Trailers: 5,000 of them, a page, a search, a filter and the free count", async () => {
    expect(await prisma.trailer.count()).toBeGreaterThan(4000);
    expect(await best(() => listTrailersPage({}))).toBeLessThan(500);
    expect(await best(() => listTrailersPage({ q: "T-0042" }))).toBeLessThan(500);
    expect(await best(() => listTrailersPage({ compliance: "lapsed", type: "dry_van" }))).toBeLessThan(800);
    expect(await best(() => countTrailersAvailable("dry_van", null))).toBeLessThan(800);
  }, 60_000);

  test("Loads: the open board and History", async () => {
    expect(await best(() => listBoardRows())).toBeLessThan(1_200);
    expect(await best(() => listHistory({}))).toBeLessThan(500);
    expect(await best(() => listHistory({ q: "SC-4412" }))).toBeLessThan(600);
    expect(await best(() => listHistory({ filter: "owed", sort: "pay" }))).toBeLessThan(800);
    // The terminal scope is sets the database builds once, not a test per load: it measured about as fast as no scope at all.
    const terminal = (await prisma.vehicle.findFirst({ where: { terminal: { not: null } }, select: { terminal: true } }))?.terminal ?? null;
    expect(await best(() => listHistory({ terminal }))).toBeLessThan(500);
    // The profit sorts price the latest thousand finished loads one by one (the figures come from the cost profile's math), so they cost about a second.
    expect(await best(() => listHistory({ sort: "profit" }))).toBeLessThan(2_000);
    expect(await best(() => listHistory({ sort: "rph", filter: "owed" }))).toBeLessThan(2_000);
    // One page of a file being written (a thousand rows, no month totals): a 25,000-row file is twenty-five of these.
    expect(await best(() => listHistory({ pageSize: 1000, lean: true }))).toBeLessThan(2_000);
    expect(await best(() => Promise.all([countDeletedLoads(), listDeletedLoads()]))).toBeLessThan(300);
  }, 60_000);

  test("the planner reads the days shown, not the history", async () => {
    expect(await best(() => getPlannerData(Date.now()))).toBeLessThan(1_500);
  }, 60_000);

  test("Invoices: each list a page at a time, terminal scope, aging aggregate, and 9,000-row Out CSV export", async () => {
    const terminal = (await prisma.vehicle.findFirst({ where: { terminal: { not: null } }, select: { terminal: true } }))?.terminal ?? null;
    expect(await best(() => listInvoiceRows(undefined, { scope: "ready", take: 25 }))).toBeLessThan(500);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50 }))).toBeLessThan(500);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50, terminal }))).toBeLessThan(600);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50, sort: { key: "due", dir: "asc" } }))).toBeLessThan(800);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50, sort: { key: "amount", dir: "desc" } }))).toBeLessThan(800);
    expect(await best(() => listInvoiceRows(undefined, { scope: "out", take: 50, q: "Customer 07" }))).toBeLessThan(800);
    expect(await best(() => listInvoiceRows(undefined, { scope: "paid", take: 50 }))).toBeLessThan(600);
    expect(await best(() => Promise.all([countInvoices("ready"), countInvoices("out"), countInvoices("paid")]))).toBeLessThan(300);
    clearAgingCache();
    expect(await best(() => agingSummary(), 1)).toBeLessThan(800);
    expect(await best(() => agingSummary())).toBeLessThan(200);
    expect(await best(() => agingSummary(Date.now(), undefined, terminal), 1)).toBeLessThan(800);
    expect(await best(() => agingFor())).toBeLessThan(400);
    expect(await best(() => getDetentionRecovery())).toBeLessThan(1_500);
    expect(await best(() => getDetentionRecovery(undefined, new Date(), terminal))).toBeLessThan(1_500);
    // Exporting all ~9,000 Out invoices reads light columns in 1,000-row pages without stop/truck joins.
    expect(await best(() => buildExport("invoices", { scope: "out" }), 1)).toBeLessThan(5_000);
  }, 60_000);

  test("Settlements and Payroll: pay owed, batched drafts and ready batch IDs", async () => {
    const terminal = (await prisma.driver.findFirst({ where: { terminal: { not: null } }, select: { terminal: true } }))?.terminal ?? null;
    expect(await best(() => settlementCounts())).toBeLessThan(300);
    expect(await best(() => listSettlements(undefined, { status: "draft", take: 25 }))).toBeLessThan(600);
    expect(await best(() => listSettlements(undefined, { status: "final", terminal, take: 50 }))).toBeLessThan(400);
    expect(await best(() => unsettledByDriver())).toBeLessThan(1_500);
    expect(await best(() => unsettledByDriver(undefined, new Date(), terminal))).toBeLessThan(1_500);
    expect(await best(() => listPayroll({ page: 1, filter: "ready", terminal }))).toBeLessThan(500);
  }, 60_000);

  test("KPI, Customers and Lanes: built once, then kept until the data moves", async () => {
    expect(await best(() => getDeskKpi({ period: "4w", compare: true }), 1)).toBeLessThan(12_000);
    expect(await best(() => getDeskKpi({ period: "4w", compare: true }))).toBeLessThan(300);
    expect(await best(() => getDeskKpi({ period: "all", compare: false }), 1)).toBeLessThan(20_000);
    expect(await best(() => getDeskKpi({ period: "all", compare: false }))).toBeLessThan(300);
  }, 120_000);

  test("one terminal's slice: the KPI, the header, the planner, the audit trail, the filter boxes and Customers stay as fast as the whole fleet", async () => {
    const terminal = (await prisma.vehicle.findFirst({ where: { terminal: { not: null } }, select: { terminal: true } }))?.terminal;
    if (!terminal) throw new Error("the scale database has no terminal");
    const t = [terminal];
    // Built once for the slice, then kept per slice.
    expect(await best(() => getDeskKpi({ period: "4w", compare: true, terminals: t }), 1)).toBeLessThan(12_000);
    expect(await best(() => getDeskKpi({ period: "4w", compare: true, terminals: t }))).toBeLessThan(300);
    const limited = { choice: { kind: "all" as const }, limit: { kind: "some" as const, regionIds: [], terminals: t } };
    expect(await best(() => getShellData(undefined, limited), 1)).toBeLessThan(6_000);
    expect(await best(() => getShellData(undefined, limited))).toBeLessThan(600);
    expect(await best(() => getPlannerData(Date.now(), Date.now(), 7, undefined, t, t))).toBeLessThan(1_500);
    expect(await best(() => listAudit({}, undefined, t, false))).toBeLessThan(1_000);
    expect(await best(() => kpiChoices("driver", "a", "4w", t))).toBeLessThan(800);
    expect(await best(() => kpiChoices("lane", "", "all", t))).toBeLessThan(1_500);
    expect(await best(() => listCustomerRecordsInScope(t))).toBeLessThan(800);
  }, 120_000);

  test("Radar: lean points, a radius search, the list and its groups, and the radius on Trucks and Trailers, at 1,500 tractors and 5,000 trailers", async () => {
    const q = (o: Record<string, string>) => readRadarParams((k) => o[k]);
    const data = await getRadarData();
    expect(data.tractors.length).toBeGreaterThan(1_000);
    expect(data.trailers.length).toBeGreaterThan(3_000);
    const all = await radarPoints(data, q({}));
    // The map is sent points, not cards: a unit costs well under 200 bytes however big the fleet is.
    expect(JSON.stringify(all.points).length / all.points.length).toBeLessThan(200);
    expect(await best(() => getRadarData())).toBeLessThan(3_000);
    expect(await best(() => radarPoints(data, q({})))).toBeLessThan(300);
    // A ZIP, a city and a state: found offline, so the cost is the measuring, not a lookup.
    for (const near of ["75201", "Atlanta, GA", "TX"]) expect(await best(() => radarPoints(data, q({ near, r: "100" })))).toBeLessThan(400);
    const dallas = await radarPoints(data, q({ near: "75201", r: "100" }));
    expect(dallas.search).toMatchObject({ ok: true });
    expect(await best(() => radarList(data, q({ near: "75201", r: "100" })))).toBeLessThan(500);
    expect(await best(() => radarList(data, q({ near: "75201", r: "100", group: "1" })))).toBeLessThan(500);
    expect(await best(() => radarList(data, q({ sort: "name", page: "40" })))).toBeLessThan(500);
    // The tables answer the same question.
    const terminal = (await prisma.vehicle.findFirst({ where: { terminal: { not: null } }, select: { terminal: true } }))?.terminal ?? null;
    const near = await unitsNear("trailers", "75201", 100, undefined, terminal);
    expect("error" in near).toBe(false);
    expect(await best(() => unitsNear("trucks", "Atlanta, GA", 100))).toBeLessThan(500);
    expect(await best(() => unitsNear("trailers", "Atlanta, GA", 100))).toBeLessThan(800);
  }, 60_000);
});
