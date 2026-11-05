import { Prisma } from "@prisma/client";
import { deskDaysBetween, dueAt } from "@/lib/overdue";
import { toCsv, type CsvCell } from "@/lib/csv";
import { filterBoard } from "@/lib/board-filter";
import { asHistoryFilter, asHistorySort } from "@/lib/loads-history";
import { prisma } from "@/lib/db";
import { parseKpiParams } from "@/lib/kpi-params";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { reasonLabel } from "@/lib/disruptions";
import { moneyState } from "@/lib/money-state";
import { asSort } from "@/lib/paging";
import { paidMethodLabel } from "@/lib/pay-method";
import { toCentralLocal } from "@/lib/zoned";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";
import { listFuel } from "@/server/partners/fuel-store";
import { storedIfta } from "@/server/partners/ifta";
import { factoringLabel } from "@/server/partners/factoring";
import { listAudit } from "./audit";
import { listTrailersPage } from "./trailers";
import { OWNERSHIPS } from "@/lib/trailer-forms";
import { statusLabel } from "@/lib/trailer-clearance";
import { trailerLabel } from "@/truelane/constants/trailerData";
import { getDeskKpi } from "./kpi";
import { listQuoteDecisions, reportScope } from "./quote-report";
import { asKpiPeriod } from "@/lib/kpi-periods";
import { listHistory } from "./history";
import { LOAD_STATUS } from "@/lib/desk-format";
import { asInvoiceShow, INVOICE_SORT_KEYS, listBoardRows, listInvoiceRows, type BoardRow, type InvoiceScope } from "./queries";
import { listSettlements } from "./settlement";
import { currentTerminal } from "./terminal";

/** The most rows one loads, invoices or statements file holds, so a click cannot build an unbounded one. A file that stopped here says so in its name. */
export const MAX_EXPORT_ROWS = 25_000;

/**
 * The CSV files the desk offers. Each is built from the same functions the screen uses (the Loads filter, the KPI engine),
 * so a file always matches what was on screen when it was asked for. Dates are the Central calendar date.
 */
export const EXPORT_KINDS = ["loads", "invoices", "settlements", "settlement-lines", "audit", "trailers", "kpi-drivers", "kpi-lanes", "kpi-brokers", "kpi-weeks", "quote-decisions", "fuel", "ifta"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

type Query = Record<string, string | string[] | undefined>;

const two = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : new Prisma.Decimal(n).toDecimalPlaces(2).toNumber());
const pctOf = (fraction: number | null | undefined): number | null => (fraction == null || !Number.isFinite(fraction) ? null : new Prisma.Decimal(fraction).times(100).toDecimalPlaces(1).toNumber());
/** A date in an export on the clock `tz`, "2026-10-30". A file is money and records: its dates are the workspace's own zone (never the display cookie), so the same load is on the same day for everyone who exports it. */
const ymdIn = (d: Date | null | undefined, tz: string): string | null => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : null);
const utcYmd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SETTLEMENT_STATUS: Record<string, string> = { draft: "Draft", final: "Finalized", void: "Void" };

export async function buildExport(kind: string, query: Query, now = new Date(), opts: { maxRows?: number } = {}): Promise<{ filename: string; csv: string } | null> {
  const cap = opts.maxRows ?? MAX_EXPORT_ROWS;
  const tz = await workspaceTimezone(currentWorkspaceId());
  const ymd = (d: Date | null | undefined) => ymdIn(d, tz);
  const day = ymd(now)!;
  const name = (part: string) => `truelane-desk-${part}-${day}.csv`;

  if (kind === "quote-decisions") {
    const scope = reportScope();
    if (scope == null) return null;
    const { rows } = await listQuoteDecisions({ period: asKpiPeriod(first(query.period)), by: scope === "all" ? null : scope }, now);
    return {
      filename: name("quote-decisions"),
      csv: toCsv(
        ["Date", "Decision", "By", "Customer", "Lane", "Offer", "First offer", "Verdict", "Read against", "Left over per mile", "Left over", "Market variance", "Truck", "Fuel price", "Fuel source", "Reason", "Notes"],
        rows.map((r) => [ymd(r.at), r.kind === "passed" ? "Passed" : r.kind === "overridden" ? "Booked, an override" : "Booked", r.by, r.customer, r.lane, two(r.offer), two(r.firstOffer), r.verdict, r.benchmark, two(r.marginPerMile), two(r.leftOver), pctOf(r.marketVariancePct), r.truck, two(r.fuelPrice), r.fuelSource, r.reason, r.notes])
      )
    };
  }

  if (kind === "loads") {
    // Asked from Loads, the file is the list on screen: the Open board with its status tab, below-cost flag and search, or History with its filter,
    // sort and search. Asked with no view (an old link), it is every load.
    const view = first(query.view);
    const q = first(query.q);
    // The header's terminal scope narrows the file the way it narrows the screen.
    const terminal = await currentTerminal();
    // History is read in pages of a thousand (it can be tens of thousands of loads); the Open board is small. A profit sort orders only the latest thousand, so a file in one of those sorts is the
    // same latest thousand, in the same order, as the screen.
    let cut = false;
    const history = async (): Promise<BoardRow[]> => {
      const out: BoardRow[] = [];
      for (let page = 1; ; page++) {
        const got = await listHistory({ filter: asHistoryFilter(first(query.filter)), sort: asHistorySort(first(query.sort)), q, page, pageSize: 1000, terminal, lean: true });
        out.push(...got.rows);
        if (out.length >= cap) {
          cut = out.length > cap || page < got.pages;
          return out.slice(0, cap);
        }
        if (page >= got.pages) return out;
      }
    };
    const rows =
      view === "history"
        ? await history()
        : filterBoard(view === "open" ? await listBoardRows(undefined, "open", terminal) : (await listBoardRows(undefined, "open", terminal)).concat(await history()), { status: first(query.status), flag: first(query.flag), q });
    // What the board does not carry: the money a load cost to run and what its driver is owed.
    const extra = await prisma.load.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { id: true, expenseFuelActual: true, expenseTolls: true, expenseMisc: true, assignment: { select: { payEstimate: true } } }
    });
    const money = new Map(
      extra.map((l) => [
        l.id,
        {
          expenses: new Prisma.Decimal(l.expenseFuelActual ?? 0).plus(l.expenseTolls ?? 0).plus(l.expenseMisc ?? 0).toDecimalPlaces(2).toNumber(),
          driverPay: l.assignment?.payEstimate == null ? null : new Prisma.Decimal(l.assignment.payEstimate).toDecimalPlaces(2).toNumber()
        }
      ])
    );
    return {
      filename: cut ? name(`loads-first-${cap}`) : name("loads"),
      csv: toCsv(
        ["Load", "Status", "Customer", "Origin", "Destination", "Pickup date", "Truck", "Driver", "Answer", "Miles", "Pay", "Pay per mile", "Floor per mile", "Verdict", "Invoice status", "Delivered", "Invoice number", "Invoiced", "Invoiced amount", "Paid", "Expenses", "Driver pay (estimate)", "Cancel reason"],
        rows.map((r): CsvCell[] => [
          r.loadNumber,
          LOAD_STATUS[r.status]?.label ?? r.status,
          r.brokerName,
          r.origin,
          r.destination,
          ymd(r.scheduledDate),
          r.vehicleName,
          r.driverName,
          r.assignmentStatus,
          two(r.totalMiles),
          two(r.grossRevenue),
          two(r.perMile),
          two(r.floorPerMile),
          r.verdict,
          r.paymentStatus === "paid" ? "Paid" : r.paymentStatus === "invoiced" ? "Invoiced" : r.status === "completed" ? "Not invoiced" : null,
          ymd(r.completedAt),
          r.invoiceNumber,
          ymd(r.invoicedAt),
          two(r.invoicedAmount),
          ymd(r.paidAt),
          money.get(r.id)?.expenses ?? null,
          money.get(r.id)?.driverPay ?? null,
          r.cancelReason ? reasonLabel(r.cancelReason) : null
        ])
      )
    };
  }

  if (kind === "invoices") {
    // The Invoices screen's own list, search, filter, sort and the header's terminal, every match, read in chunks (a fleet has tens of thousands of invoices).
    const terminal = await currentTerminal();
    const rawScope = first(query.scope);
    const scope: InvoiceScope = rawScope === "ready" || rawScope === "out" || rawScope === "paid" ? rawScope : "all";
    const show = scope === "out" || scope === "all" ? asInvoiceShow(first(query.show)) : null;
    const rawSort = first(query.sort);
    const sort = rawSort ? asSort(rawSort, INVOICE_SORT_KEYS, { key: "sent", dir: "asc" }) : null;
    const q = first(query.q);
    const rows: Awaited<ReturnType<typeof listInvoiceRows>> = [];
    let cut = false;
    for (let skip = 0; ; skip += 1000) {
      const remaining = cap - rows.length;
      const take = remaining < 1000 ? remaining : 1000;
      const got = await listInvoiceRows(undefined, { scope, q, show, sort, terminal, skip, take, lean: true });
      rows.push(...got);
      if (got.length < take) break;
      if (rows.length >= cap) {
        const probe = await listInvoiceRows(undefined, { scope, q, show, sort, terminal, skip: rows.length, take: 1, lean: true });
        cut = probe.length > 0;
        break;
      }
    }
    const part = scope === "all" ? "invoices" : `invoices-${scope}`;
    return {
      filename: cut ? name(`${part}-first-${cap}`) : name(part),
      csv: toCsv(
        ["Load", "PO", "Invoice", "Customer", "Lane", "Delivered", "Invoiced", "Due", "Paid", "Terms (days)", "Amount", "Received", "Balance owed", "Payment method", "Factoring", "Write-off", "Write-off reason", "Days overdue", "Status"],
        rows.map((r): CsvCell[] => {
          const billed = r.status === null ? r.readyAmount : r.amount;
          const due = dueAt(r.invoicedAt, r.payTermsDays);
          const late = r.status === "invoiced" && due ? deskDaysBetween(due, now) : null;
          const overdueDays = late != null && late > 0 ? late : r.status === "invoiced" ? 0 : null;
          const m = moneyState({
            paymentStatus: r.status,
            billed,
            received: r.paidAmount,
            writeOffAmount: r.writeOffAmount,
            writeOffReason: r.writeOffReason,
            overdueDays: late
          });
          return [
            r.loadNumber,
            r.poNumber,
            r.invoiceNumber,
            r.broker,
            r.lane,
            ymd(r.completedAt),
            ymd(r.invoicedAt),
            ymd(due),
            ymd(r.paidAt),
            r.payTermsDays,
            two(billed),
            r.paidAmount != null ? two(r.paidAmount) : null,
            r.status === "invoiced" ? two(r.balance) : r.status === "paid" ? 0 : null,
            r.paidMethod ? paidMethodLabel(r.paidMethod) : null,
            r.factoringStatus && r.factoringStatus !== "none" ? factoringLabel(r.factoringStatus) : null,
            r.writeOffAmount != null && r.writeOffAmount > 0 ? two(r.writeOffAmount) : null,
            r.writeOffReason,
            overdueDays,
            m.detail ? `${m.label} (${m.detail})` : m.label
          ];
        })
      )
    };
  }

  if (kind === "settlements" || kind === "settlement-lines") {
    const terminal = await currentTerminal();
    const rawStatus = first(query.status);
    const status = rawStatus === "draft" || rawStatus === "final" || rawStatus === "void" ? rawStatus : undefined;
    if (kind === "settlements") {
      const rows: Awaited<ReturnType<typeof listSettlements>> = [];
      let cut = false;
      for (let skip = 0; ; skip += 1000) {
        const remaining = cap - rows.length;
        const take = remaining < 1000 ? remaining : 1000;
        const got = await listSettlements(undefined, { status, terminal, skip, take });
        rows.push(...got);
        if (got.length < take) break;
        if (rows.length >= cap) {
          const probe = await listSettlements(undefined, { status, terminal, skip: rows.length, take: 1 });
          cut = probe.length > 0;
          break;
        }
      }
      return {
        filename: cut ? name(`settlements-first-${cap}`) : name("settlements"),
        csv: toCsv(
          ["Statement", "Status", "Driver", "Period start", "Period end", "Loads", "Pay for loads", "Adjustments", "Total", "Finalized", "Paid", "Payment method", "Payroll sent", "Payroll reference", "Voided", "Void reason"],
          rows.map((s): CsvCell[] => [
            s.number,
            SETTLEMENT_STATUS[s.status] ?? s.status,
            s.driverName,
            utcYmd(s.periodStart),
            utcYmd(s.periodEnd),
            s.loads,
            two(s.loadsTotal),
            two(s.adjustmentsTotal),
            two(s.total),
            ymd(s.finalizedAt),
            ymd(s.paidAt),
            s.paidMethod ? paidMethodLabel(s.paidMethod) : null,
            ymd(s.payrollSentAt),
            s.payrollReference,
            ymd(s.voidedAt),
            s.voidReason
          ])
        )
      };
    }

    const lines: CsvCell[][] = [];
    let cut = false;
    for (let skip = 0; ; skip += 500) {
      const got = await listSettlements(undefined, { status, terminal, skip, take: 500 });
      if (got.length === 0) break;
      for (const s of got) {
        const head: CsvCell[] = [s.number, SETTLEMENT_STATUS[s.status] ?? s.status, s.driverName, utcYmd(s.periodStart), utcYmd(s.periodEnd)];
        for (const l of s.statement.lines) {
          if (lines.length >= cap) {
            cut = true;
            break;
          }
          lines.push([...head, "Load", l.loadNumber, l.lane, l.deliveredAt ? ymd(new Date(l.deliveredAt)) : null, l.basis, two(l.amount)]);
        }
        if (cut) break;
        for (const a of s.statement.adjustments) {
          if (lines.length >= cap) {
            cut = true;
            break;
          }
          lines.push([...head, "Adjustment", null, null, null, a.label, two(a.amount)]);
        }
        if (cut) break;
      }
      if (cut || got.length < 500) break;
    }
    return {
      filename: cut ? name(`settlement-lines-first-${cap}`) : name("settlement-lines"),
      csv: toCsv(["Statement", "Status", "Driver", "Period start", "Period end", "Kind", "Load", "Lane", "Delivered", "Basis", "Amount"], lines)
    };
  }

  if (kind === "fuel") {
    // The Fuel screen's own period, every purchase in it, a page at a time.
    const days = Math.min(Math.max(1, parseInt(first(query.days) ?? "30", 10) || 30), 366);
    const rows: Awaited<ReturnType<typeof listFuel>>["rows"] = [];
    for (let page = 1; ; page++) {
      const got = await listFuel({ days, page }, now);
      rows.push(...got.rows);
      if (rows.length >= cap || rows.length >= got.total) break;
    }
    return {
      filename: name(`fuel-${days}d`),
      csv: toCsv(
        ["Date", "Truck", "Where", "Card company", "Gallons", "Price a gallon", "Discount a gallon", "Discount", "Charged", "Load", "Driver statement"],
        rows.slice(0, cap).map((r): CsvCell[] => [ymdIn(r.postedAt, "UTC"), r.truck, r.location, r.providerName, r.gallons, r.pricePerGallon, r.discountPerGallon, r.discount, r.amount, r.loadNumber, r.statementNumber])
      )
    };
  }

  if (kind === "ifta") {
    const quarter = first(query.quarter) ?? "";
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) return null;
    const lines = await storedIfta(quarter);
    return {
      filename: name(`ifta-${quarter}`),
      csv: toCsv(
        ["Quarter", "State", "Miles", "Gallons used", "Worked out by", "Delivered loads", "Worked out"],
        lines.map((l): CsvCell[] => [quarter, l.state, l.miles, l.gallons, l.source, l.loads, ymd(l.computedAt)])
      )
    };
  }

  if (kind === "trailers") {
    // The Trailers screen's own filters, every match, read a thousand at a time (a fleet has thousands of trailers).
    const base = { q: first(query.q), sort: first(query.sort), type: first(query.type), status: first(query.status), ownership: first(query.ownership), compliance: first(query.compliance), archived: first(query.archived) === "1", pageSize: 1000 };
    const rows: Awaited<ReturnType<typeof listTrailersPage>>["rows"] = [];
    for (let page = 1; ; page++) {
      const got = await listTrailersPage({ ...base, page }, now);
      rows.push(...got.rows);
      if (page >= got.pages) break;
    }
    return {
      filename: name("trailers"),
      csv: toCsv(
        ["Number", "Type", "Plate", "Plate state", "Ownership", "Status", "Terminal", "Location", "Hooked to", "On now", "Registration good through", "Inspection good through", "Papers"],
        rows.map((t): CsvCell[] => [t.number, t.type ? trailerLabel(t.type) : null, t.plate, t.plateState, OWNERSHIPS.find((o) => o.key === t.ownership)?.label ?? t.ownership, statusLabel(t.status), t.terminal, t.location, t.hookedTo, t.onLoads.map((l) => l.loadNumber).join(" "), ymd(t.registrationExpiry), ymd(t.inspectionExpiry), t.compliance])
      )
    };
  }

  if (kind === "audit") {
    // The audit page's own filters (search, area, From and To day), every match rather than one page, newest first, capped so one click cannot build a huge file.
    const { rows, total } = await listAudit({ q: first(query.q), group: first(query.group), from: first(query.from), to: first(query.to), page: 1, pageSize: 5000 });
    return {
      // At the cap the file is the newest 5,000 of more: its name says so, so nobody reads it as the whole log.
      filename: total > rows.length ? name(`audit-log-latest-${rows.length}`) : name("audit-log"),
      csv: toCsv(
        ["When (Central)", "Load", "What", "Detail", "Reason", "By"],
        rows.map((e): CsvCell[] => [toCentralLocal(e.createdAt.getTime(), tz).replace("T", " "), e.loadNumber, ACTION_LABEL[e.action] ?? e.action, e.summary, e.reason, e.actor])
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
          ["Driver", "Loads", "Gross", "Per revenue mile", "Miles driven", "Empty miles", "Empty miles (%)", "Est. driver pay"],
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
        filename: `truelane-desk-kpi-customers-${tag}.csv`,
        csv: toCsv(
          ["Customer", "Loads", "Gross", "Per revenue mile", "Against market (%)", "Loads with a market rate", "Paid invoices", "Days to pay", "Average wait at a stop (min)", "Cancelled or TONU"],
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
