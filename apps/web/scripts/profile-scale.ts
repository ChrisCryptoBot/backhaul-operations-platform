// Times what each desk screen reads, on whichever database DATABASE_URL names (a developer aid, not part of the app). The numbers are the data layer only;
// a screen adds its own rendering, so the browser or curl is the last word (docs/DEMO_REBUILD.md keeps both).
//   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale npx tsx scripts/profile-scale.ts [name ...]
// With names it runs only those (for example `kpi fit`); with none it runs everything.
import { BLANK_QUOTE, readQuote } from "../src/lib/quote";
import { listAudit } from "../src/server/tl/audit";
import { getAlerts } from "../src/server/tl/alerts";
import { getDetentionRecovery } from "../src/server/tl/detention";
import { listDriversPage, listTrucksPage } from "../src/server/tl/fleet-list";
import { listHistory } from "../src/server/tl/history";
import { getDeskKpi, getKpiRows, rowsSince } from "../src/server/tl/kpi";
import { getPlannerData } from "../src/server/tl/planner";
import { agingFor, countInvoices, listBoardRows, listInvoiceRows } from "../src/server/tl/queries";
import { fitQuote } from "../src/server/tl/quote";
import { listSettlements, settlementCounts, unsettledByDriver } from "../src/server/tl/settlement";
import { getShellData } from "../src/server/tl/shell";
import { countTrailersAvailable, listTrailersPage } from "../src/server/tl/trailers";

const quote = () => {
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

const steps: Array<[string, () => Promise<unknown>]> = [
  ["shell", () => getShellData()],
  ["fit", () => fitQuote(quote())],
  ["board", () => listBoardRows()],
  ["history", () => listHistory({})],
  ["history-search", () => listHistory({ q: "Customer 07" })],
  ["alerts-shell", () => getAlerts(new Date(), undefined, "shell")],
  ["alerts-all", () => getAlerts(new Date(), undefined, "all")],
  ["planner", () => getPlannerData(Date.now())],
  ["trucks", () => listTrucksPage({})],
  ["drivers", () => listDriversPage({})],
  ["trailers", () => listTrailersPage({})],
  ["trailers-search", () => listTrailersPage({ q: "T-0042" })],
  ["trailers-lapsed", () => listTrailersPage({ compliance: "lapsed", type: "dry_van" })],
  ["trailers-free", () => countTrailersAvailable("dry_van", null)],
  ["invoices-ready", () => listInvoiceRows(undefined, { scope: "ready", take: 50 })],
  ["invoices-out", () => listInvoiceRows(undefined, { scope: "out", take: 50 })],
  ["invoices-paid", () => listInvoiceRows(undefined, { scope: "paid", take: 50 })],
  ["invoices-counts", () => Promise.all([countInvoices("ready"), countInvoices("out"), countInvoices("paid")])],
  ["aging", () => agingFor()],
  ["detention", () => getDetentionRecovery()],
  ["settlements", () => Promise.all([settlementCounts(), listSettlements(undefined, { take: 50 })])],
  ["unsettled", () => unsettledByDriver()],
  ["audit", () => listAudit({})],
  ["kpi-rows-4w", () => getKpiRows(undefined, { since: new Date(rowsSince("4w", Date.now())) })],
  ["kpi-4w", () => getDeskKpi({ period: "4w", compare: true })],
  ["kpi-all", () => getDeskKpi({ period: "all", compare: false })]
];

async function main() {
  const only = process.argv.slice(2);
  for (const [name, run] of steps) {
    if (only.length > 0 && !only.includes(name)) continue;
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await run();
      times.push(Date.now() - t);
    }
    console.log(name.padEnd(18), times.map((t) => `${t} ms`).join("  "));
  }
}
main().then(() => process.exit(0));
