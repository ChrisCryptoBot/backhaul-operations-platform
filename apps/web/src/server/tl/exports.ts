import { Prisma } from "@prisma/client";
import { toCsv, type CsvCell } from "@/lib/csv";
import { filterBoard } from "@/lib/board-filter";
import { parseKpiParams } from "@/lib/kpi-params";
import { DESK_TZ } from "@/lib/zoned";
import { getDeskKpi } from "./kpi";
import { listBoardRows, listInvoiceRows } from "./queries";

/**
 * The CSV files the desk offers. Each is built from the same functions the screen uses (the Loads filter, the KPI engine),
 * so a file always matches what was on screen when it was asked for. Dates are the Central calendar date.
 */
export const EXPORT_KINDS = ["loads", "invoices", "kpi-drivers", "kpi-lanes", "kpi-brokers", "kpi-weeks"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

type Query = Record<string, string | string[] | undefined>;

const two = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : new Prisma.Decimal(n).toDecimalPlaces(2).toNumber());
const pctOf = (fraction: number | null | undefined): number | null => (fraction == null || !Number.isFinite(fraction) ? null : new Prisma.Decimal(fraction).times(100).toDecimalPlaces(1).toNumber());
const ymd = (d: Date | null | undefined): string | null => (d ? d.toLocaleDateString("en-CA", { timeZone: DESK_TZ }) : null);
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function buildExport(kind: string, query: Query, now = new Date()): Promise<{ filename: string; csv: string } | null> {
  const day = ymd(now)!;
  const name = (part: string) => `truelane-desk-${part}-${day}.csv`;

  if (kind === "loads") {
    const rows = filterBoard(await listBoardRows(), { status: first(query.status), flag: first(query.flag), q: first(query.q) });
    return {
      filename: name("loads"),
      csv: toCsv(
        ["Load", "Status", "Broker", "Origin", "Destination", "Pickup date", "Truck", "Driver", "Answer", "Miles", "Pay", "Pay per mile", "Floor per mile", "Verdict", "Invoice status"],
        rows.map((r): CsvCell[] => [r.loadNumber, r.status, r.brokerName, r.origin, r.destination, ymd(r.scheduledDate), r.vehicleName, r.driverName, r.assignmentStatus, two(r.totalMiles), two(r.quotedRevenue), two(r.perMile), two(r.floorPerMile), r.verdict, r.paymentStatus])
      )
    };
  }

  if (kind === "invoices") {
    const rows = await listInvoiceRows();
    return {
      filename: name("invoices"),
      csv: toCsv(
        ["Load", "Invoice", "Broker", "Lane", "Delivered", "Invoiced", "Due", "Paid", "Terms (days)", "Amount", "Status"],
        rows.map((r): CsvCell[] => [
          r.loadNumber,
          r.invoiceNumber,
          r.broker,
          r.lane,
          ymd(r.completedAt),
          ymd(r.invoicedAt),
          r.invoicedAt ? ymd(new Date(r.invoicedAt.getTime() + (r.payTermsDays ?? 0) * 86_400_000)) : null,
          ymd(r.paidAt),
          r.payTermsDays,
          two(r.amount),
          r.status ?? "not invoiced"
        ])
      )
    };
  }

  if (kind === "kpi-drivers" || kind === "kpi-lanes" || kind === "kpi-brokers" || kind === "kpi-weeks") {
    const p = parseKpiParams(query);
    const k = await getDeskKpi({ period: p.period, compare: false, filters: p.filters }, now);
    const tag = `${p.period}-${day}`;
    if (kind === "kpi-drivers") {
      return {
        filename: `truelane-desk-kpi-drivers-${tag}.csv`,
        csv: toCsv(
          ["Driver", "Loads", "Gross", "Per revenue mile", "Miles driven", "Empty miles", "Empty miles (%)", "Pay owed (estimate)"],
          k.drivers.map((d): CsvCell[] => [d.name, d.loads, two(d.gross), two(d.rpm), two(d.drivenMiles), two(d.emptyMiles), pctOf(d.emptyShare), two(d.payOwed)])
        )
      };
    }
    if (kind === "kpi-lanes") {
      return {
        filename: `truelane-desk-kpi-lanes-${tag}.csv`,
        csv: toCsv(
          ["Lane", "Loads", "Gross", "Per revenue mile", "Empty miles (%)", "Avg empty before pickup", "Avg empty after delivery", "Loads with a market rate", "Against market (%)", "Status"],
          k.lanes.map((l): CsvCell[] => [l.key, l.loads, two(l.gross), two(l.rpm), pctOf(l.emptyShare), two(l.avgPickupEmpty), two(l.avgReturnEmpty), l.benchmarked, pctOf(l.marketVariancePct), l.status === "above" ? "above market" : l.status === "below" ? "below market" : "no market rate"])
        )
      };
    }
    if (kind === "kpi-brokers") {
      return {
        filename: `truelane-desk-kpi-brokers-${tag}.csv`,
        csv: toCsv(
          ["Broker", "Loads", "Gross", "Per revenue mile", "Against market (%)", "Loads with a market rate", "Paid invoices", "Days to pay", "Average wait at a stop (min)", "Cancelled or TONU"],
          k.brokers.map((b): CsvCell[] => [b.name, b.loads, two(b.gross), two(b.rpm), pctOf(b.marketVariancePct), b.benchmarked, b.paidLoads, two(b.avgDaysToPay), two(b.avgWaitMinutes), b.lost])
        )
      };
    }
    return {
      filename: `truelane-desk-kpi-weeks-${tag}.csv`,
      csv: toCsv(
        ["Week ending", "Gross", "Loads", "Per revenue mile", "Empty miles (%)"],
        k.trend.map((w): CsvCell[] => [ymd(new Date(w.end)), two(w.gross), w.loads, two(w.rpm), pctOf(w.emptyShare)])
      )
    };
  }

  return null;
}
