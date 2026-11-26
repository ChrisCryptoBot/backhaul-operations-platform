import { termList } from "@/lib/scope";
import { cashFileRows } from "@/lib/cash";
import { getKpiCash } from "./cash";
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
import { FLAG_LABEL } from "@/lib/fuel-exceptions";
import { PRODUCT_LABEL, STATUS_LABEL } from "@/lib/fuel-normalize";
import { listFuel } from "@/server/partners/fuel-store";
import { iftaReturnDetail } from "@/server/partners/ifta-return";
import { providerName } from "@/server/partners/call";
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
import { asInvoiceShow, boardRowOf, INVOICE_SORT_KEYS, listBoardRows, listInvoiceRows, loadInclude, type BoardRow, type InvoiceScope } from "./queries";
import { inTerminal } from "./terminal-sql";
import { notQuote } from "@/lib/quote-status";
import { listSettlements } from "./settlement";
import { DEDUCTION_ROW_LABEL } from "@/lib/deductions";
import { contractor1099, form1099Csv } from "./form1099";
import { currentTerminal } from "./terminal";
import { checkAccess } from "./access";
import { currentAllowed } from "./scope";
import { getLeakLedger } from "./leaks";
import { getDataHealth } from "./data-health";
import { LEAKS, leakMeta } from "@/lib/leaks";

/** The most rows one loads, invoices or statements file holds, so a click cannot build an unbounded one. A file that stopped here says so in its name. */
export const MAX_EXPORT_ROWS = 25_000;

/**
 * The CSV files the desk offers. Each is built from the same functions the screen uses (the Loads filter, the KPI engine),
 * so a file always matches what was on screen when it was asked for. Dates are the Central calendar date.
 */
export const EXPORT_KINDS = ["loads", "invoices", "settlements", "settlement-lines", "audit", "trailers", "kpi-drivers", "kpi-lanes", "kpi-brokers", "kpi-weeks", "kpi-trucks", "kpi-cash", "leaks", "leaks-weeks", "leaks-items", "data-health", "data-health-checks", "quote-decisions", "fuel", "ifta", "ifta-audit", "contractor-1099"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

type Query = Record<string, string | string[] | undefined>;

const two = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : new Prisma.Decimal(n).toDecimalPlaces(2).toNumber());
const pctOf = (fraction: number | null | undefined): number | null => (fraction == null || !Number.isFinite(fraction) ? null : new Prisma.Decimal(fraction).times(100).toDecimalPlaces(1).toNumber());
/** A date in an export on the clock `tz`, "2026-10-30". A file is money and records: its dates are the workspace's own zone (never the display cookie), so the same load is on the same day for everyone who exports it. */
const ymdIn = (d: Date | null | undefined, tz: string): string | null => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : null);
const utcYmd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Where a leak line's dollars come from, in the leak files' "Priced from" column. */
const pricedFrom = (x: { intake: boolean; partner: boolean }) => (x.intake ? "the carrier's intake, not frozen at booking" : x.partner ? "a partner record kept on the desk (the factor's figures, a fuel card purchase, a filed IFTA return)" : "a figure frozen on the load or recorded on it");

const SETTLEMENT_STATUS: Record<string, string> = { draft: "Draft", final: "Finalized", void: "Void" };

export async function buildExport(kind: string, query: Query, now = new Date(), opts: { maxRows?: number } = {}): Promise<{ filename: string; csv: string } | null> {
  const cap = opts.maxRows ?? MAX_EXPORT_ROWS;
  const tz = await workspaceTimezone(currentWorkspaceId());
  const ymd = (d: Date | null | undefined) => ymdIn(d, tz);
  const day = ymd(now)!;
  const name = (part: string) => `truelane-desk-${part}-${day}.csv`;

  if (kind === "quote-decisions") {
    const scope = await reportScope();
    if (scope == null) return null;
    const { rows } = await listQuoteDecisions({ period: asKpiPeriod(first(query.period)), by: scope === "all" ? null : scope, terminals: await currentTerminal() }, now);
    return {
      filename: name("quote-decisions"),
      csv: toCsv(
        ["Date", "Decision", "By", "Customer", "Lane", "Offer", "First offer", "Verdict", "Read against", "Left over per mile", "Left over", "Market variance", "Truck", "Fuel price", "Fuel source", "Reason", "Notes"],
        rows.map((r) => [ymd(r.at), r.kind === "passed" ? "Passed" : r.kind === "overridden" ? "Booked, an override" : "Booked", r.by, r.customer, r.lane, two(r.offer), two(r.firstOffer), r.verdict, r.benchmark, two(r.marginPerMile), two(r.leftOver), pctOf(r.marketVariancePct), r.truck, two(r.fuelPrice), r.fuelSource, r.reason, r.notes])
      )
    };
  }

  if (kind === "loads") {
    // Asked from Loads, the file is the list on screen (or explicit selected IDs via ?ids=): the Open board with its status tab, below-cost flag and search, or History with its filter,
    // sort and search. Asked with no view (an old link), it is every load.
    const view = first(query.view);
    const q = first(query.q);
    const rawIds = first(query.ids);
    const pickedIds = rawIds
      ? [...new Set(rawIds.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, cap)
      : null;
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
    const rows = pickedIds
      ? pickedIds.length === 0
        ? []
        : (
            await prisma.load.findMany({
              where: {
                id: { in: pickedIds },
                workspaceId: currentWorkspaceId(),
                deletedAt: null,
                ...notQuote,
                ...inTerminal(terminal)
              },
              include: loadInclude,
              orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }]
            })
          ).map(boardRowOf)
      : view === "history"
        ? await history()
        : filterBoard(view === "open" ? await listBoardRows(undefined, "open", terminal) : (await listBoardRows(undefined, "open", terminal)).concat(await history()), { status: first(query.status), flag: first(query.flag), q });
    const showDriverPay = (await checkAccess("billing_details")).ok;
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
          driverPay: !showDriverPay || l.assignment?.payEstimate == null ? null : new Prisma.Decimal(l.assignment.payEstimate).toDecimalPlaces(2).toNumber()
        }
      ])
    );
    return {
      filename: cut ? name(`loads-first-${cap}`) : pickedIds ? name("loads-selected") : name("loads"),
      csv: toCsv(
        ["Load", "Status", "Customer", "Origin", "Destination", "Pickup date", "Truck", "Driver", "Answer", "Miles", "Pay", "Pay per mile", "Floor per mile", "Verdict", "Invoice status", "Delivered", "Invoice number", "Invoiced", "Invoiced amount", "Paid", "Expenses", ...(showDriverPay ? ["Driver pay (estimate)"] : []), "Cancel reason"],
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
          ...(showDriverPay ? [money.get(r.id)?.driverPay ?? null] : []),
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
          ["Statement", "Status", "Driver", "Period start", "Period end", "Loads", "Pay for loads", "Fuel card deducted", "Adjustments", "Deductions, escrow and advances", "Total", "Finalized", "Paid", "Payment method", "Payroll sent", "Payroll reference", "Voided", "Void reason"],
          rows.map((s): CsvCell[] => [
            s.number,
            SETTLEMENT_STATUS[s.status] ?? s.status,
            s.driverName,
            utcYmd(s.periodStart),
            utcYmd(s.periodEnd),
            s.loads,
            two(s.loadsTotal),
            two(s.fuelTotal),
            two(s.adjustmentsTotal),
            two(s.deductionsTotal),
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
        for (const f of s.statement.fuel) {
          if (lines.length >= cap) {
            cut = true;
            break;
          }
          // A deduction is negative in the file, as it is on the statement.
          lines.push([...head, "Fuel card", f.loadNumber, null, f.on, `${f.location ?? "Fuel card purchase"}${f.gallons != null ? `, ${f.gallons} gal` : ""}`, two(-f.amount)]);
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
        // Deductions, escrow and advances held are negative, an escrow release positive, as on the statement. The basis names the kind of deduction, or why escrow was released.
        for (const d of s.statement.deductions) {
          if (lines.length >= cap) {
            cut = true;
            break;
          }
          lines.push([...head, DEDUCTION_ROW_LABEL[d.kind], null, null, null, d.basis ? `${d.label}: ${d.basis}` : d.label, two(d.amount)]);
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
    // The Fuel screen's own scope: the terminals in view.
    const terminal = await currentTerminal();
    for (let page = 1; ; page++) {
      const got = await listFuel({ days, page, terminal }, now);
      rows.push(...got.rows);
      if (rows.length >= cap || rows.length >= got.total) break;
    }
    return {
      filename: name(`fuel-${days}d`),
      csv: toCsv(
        ["Date", "Truck", "Where", "State", "Product", "Status", "Card company", "Gallons", "Price a gallon", "Discount a gallon", "Discount", "Charged", "Load", "Driver statement", "Open flags"],
        rows.slice(0, cap).map((r): CsvCell[] => [ymdIn(r.postedAt, "UTC"), r.truck, r.location, r.state, PRODUCT_LABEL[r.product], STATUS_LABEL[r.status], r.providerName, r.gallons, r.pricePerGallon, r.discountPerGallon, r.discount, r.amount, r.loadNumber, r.statementNumber, r.flags.open.map((f) => FLAG_LABEL[f.code]).join("; ")])
      )
    };
  }

  if (kind === "contractor-1099") {
    // The 1099 screen's own year and scope, from the statement rows. Tax details: the route lets only the billing office ask for it.
    const year = first(query.year) ?? "";
    if (!/^\d{4}$/.test(year)) return null;
    const report = await contractor1099(Number.parseInt(year, 10), { terminal: await currentTerminal() });
    return { filename: name(`contractor-1099-${year}`), csv: form1099Csv(report) };
  }

  if (kind === "ifta" || kind === "ifta-audit") {
    // The quarter's return and the rows behind it, from one read (server/partners/ifta-return.ts): the screen, the audit page and both files always agree. The route lets only the billing office ask.
    const quarter = first(query.quarter) ?? "";
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) return null;
    const truck = first(query.truck) || null;
    const r = await iftaReturnDetail(quarter, kind === "ifta-audit" && truck ? { vehicleId: truck } : {}, now);
    if (!r.ok) return null;
    // Figures go in as numbers (exact decimals, read once), so a credit's minus sign is a number's, not text the CSV writer has to defuse.
    const dn = (v: string | null) => (v == null ? null : new Prisma.Decimal(v).toNumber());
    if (kind === "ifta") {
      return {
        filename: name(`ifta-${quarter}`),
        csv: toCsv(
          ["Quarter", "Jurisdiction", "Name", "Miles", "Taxable gallons", "Tax-paid gallons", "Net gallons", "Rate", "Tax", "Surcharge rate", "Surcharge", "Total", "Fleet MPG", "Due"],
          [
            ...r.lines.map((l): CsvCell[] => [quarter, l.jurisdiction, l.name, dn(l.miles), dn(l.taxableGallons), dn(l.taxPaidGallons), dn(l.netGallons), dn(l.rate), dn(l.tax), dn(l.surchargeRate), dn(l.surcharge), dn(l.total), dn(r.mpg), r.dueDate]),
            [quarter, "ALL", "All jurisdictions", dn(r.miles), null, null, null, null, dn(r.tax), null, dn(r.surcharge), dn(r.total), dn(r.mpg), r.dueDate]
          ]
        )
      };
    }
    const names = new Map(r.trucks.map((t) => [t.vehicleId, t.name]));
    const iso = (d: Date) => d.toISOString();
    return {
      filename: name(`ifta-audit-${quarter}${truck ? `-${(names.get(truck) ?? "truck").replace(/[^A-Za-z0-9]+/g, "-")}` : ""}`),
      csv: toCsv(
        ["Quarter", "Record", "Truck", "Method", "Source", "Jurisdiction", "Loaded", "Load", "Start odometer", "End odometer", "Started (UTC)", "Ended (UTC)", "Miles", "Piece or receipt id", "Bought (UTC)", "Location", "Product", "Status", "Tax paid", "Gallons", "Amount", "Counted"],
        [
          ...r.pieces.map((p): CsvCell[] => [quarter, "miles", names.get(p.vehicleId) ?? p.vehicleId, p.method === "eld" ? "ELD" : "Routed", providerName(p.source), p.jurisdiction, p.loaded ? "loaded" : "empty", p.loadNumber, dn(p.startOdometer), dn(p.endOdometer), iso(p.startedAt), iso(p.endedAt), dn(p.miles), p.externalId, null, null, null, null, null, null, null, "yes"]),
          ...r.receipts.map((f): CsvCell[] => [quarter, "fuel", f.vehicleId ? (names.get(f.vehicleId) ?? f.vehicleId) : null, null, providerName(f.provider), f.state, null, null, null, null, null, null, null, f.externalId, iso(f.at), f.location, PRODUCT_LABEL[f.product as keyof typeof PRODUCT_LABEL] ?? f.product, STATUS_LABEL[f.status as keyof typeof STATUS_LABEL] ?? f.status, f.taxPaid ? "yes" : "no", dn(f.gallons), dn(f.amount), f.counted ? "yes" : "no"])
        ]
      )
    };
  }

  if (kind === "trailers") {
    // The Trailers screen's own filters, every match, read a thousand at a time (a fleet has thousands of trailers).
    const base = { q: first(query.q), sort: first(query.sort), type: first(query.type), status: first(query.status), ownership: first(query.ownership), compliance: first(query.compliance), archived: first(query.archived) === "1", pageSize: 1000, terminal: await currentTerminal() };
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
    const { rows, total } = await listAudit({ q: first(query.q), group: first(query.group), from: first(query.from), to: first(query.to), page: 1, pageSize: 5000 }, undefined, await currentTerminal(), (await currentAllowed()) == null);
    return {
      // At the cap the file is the newest 5,000 of more: its name says so, so nobody reads it as the whole log.
      filename: total > rows.length ? name(`audit-log-latest-${rows.length}`) : name("audit-log"),
      csv: toCsv(
        ["When (Central)", "Load", "What", "Detail", "Reason", "By"],
        rows.map((e): CsvCell[] => [toCentralLocal(e.createdAt.getTime(), tz).replace("T", " "), e.loadNumber, ACTION_LABEL[e.action] ?? e.action, e.summary, e.reason, e.actor])
      )
    };
  }

  // The Leak Ledger (billing office only: the route asks for it). The same read the screen uses, for the terminal in view; the lines, the twelve weeks, or the biggest single items.
  if (kind === "leaks" || kind === "leaks-weeks" || kind === "leaks-items") {
    const p = parseKpiParams(query);
    const terminal = await currentTerminal();
    const l = await getLeakLedger({ period: p.period, compare: false, terminals: termList(terminal) }, now);
    const tag = `${p.period}-${day}`;
    if (kind === "leaks") {
      return {
        filename: `truelane-desk-leaks-${tag}.csv`,
        csv: toCsv(
          ["Leak", "Dollars", "Items", "Items not priced", "Empty miles not priced", "Counted in the total", "Priced from", "Basis"],
          l.current.lines.map((x): CsvCell[] => [x.label, two(x.dollars), x.items, x.unpriced, two(x.unpricedMiles), x.counted ? "yes" : "no", pricedFrom(x), x.basis])
        )
      };
    }
    if (kind === "leaks-weeks") {
      return {
        filename: `truelane-desk-leaks-weeks-${tag}.csv`,
        csv: toCsv(
          ["Week ending", ...LEAKS.map((m) => `${m.label}${m.counted ? "" : " (not in the total)"}`), "Total (counted lines)"],
          l.weeks.map((w): CsvCell[] => [ymd(new Date(w.end)), ...LEAKS.map((m) => two(w.byKey[m.key])), two(w.total)])
        )
      };
    }
    return {
      filename: `truelane-desk-leaks-items-${tag}.csv`,
      csv: toCsv(
        ["Date", "Leak", "Load or trailer", "Lane", "Customer", "Truck", "Priced from", "Intake figure used", "Dollars"],
        l.top.map((t): CsvCell[] => [ymd(new Date(t.at)), leakMeta(t.key).label, t.label, t.lane, t.customer, t.truck, pricedFrom(t), t.basisNote, two(t.dollars)])
      )
    };
  }

  // Data health (billing office only: the route asks for it): every check with how many items it covered and how many are missing, or the three cross-source checks as counts and dollars.
  if (kind === "data-health" || kind === "data-health-checks") {
    const p = parseKpiParams(query);
    const h = await getDataHealth({ period: p.period, terminals: termList(await currentTerminal()) }, now);
    const tag = `${p.period}-${day}`;
    if (kind === "data-health") {
      return {
        filename: `truelane-desk-data-health-${tag}.csv`,
        csv: toCsv(
          ["Module", "Check", "Items checked", "Filled in", "Missing", "Why it matters", "Examples"],
          h.completeness.checks.map((c): CsvCell[] => [c.module, c.label, c.checked, c.passed, c.gaps, c.why, c.examples.map((e) => e.label).join(" ")])
        )
      };
    }
    const f = h.fuel;
    const r = h.rateCon;
    const g = h.pings;
    const rows: CsvCell[][] = [
      ["Fuel card and the load's own fuel", "Loads with a card purchase", f.withCard, null],
      ["Fuel card and the load's own fuel", "Match (within the larger of $25 and a tenth)", f.matched, null],
      ["Fuel card and the load's own fuel", "Apart", f.off, two(f.offDollars)],
      ["Fuel card and the load's own fuel", "Card purchase and no fuel recorded on the load", f.cardOnly, two(f.cardOnlyDollars)],
      ["Fuel card and the load's own fuel", "Fuel recorded and no card purchase tied to the load", f.loadOnly, null],
      ["Rate confirmation and the invoice", "Invoiced loads", r.invoiced, null],
      ["Rate confirmation and the invoice", "With a rate confirmation on file", r.checkable, null],
      ["Rate confirmation and the invoice", "Billed what it promised", r.matched, null],
      ["Rate confirmation and the invoice", "Billed under it", r.under, two(r.underDollars)],
      ["Rate confirmation and the invoice", "Billed over the rate and surcharge", r.over, two(r.overDollars)],
      ["Rate confirmation and the invoice", "No rate confirmation to check against", r.unchecked, null],
      ["Truck positions and billed miles (last 7 days)", "Finished loads with a truck", g.trips, null],
      ["Truck positions and billed miles (last 7 days)", "Measured (enough pings)", g.measured, null],
      ["Truck positions and billed miles (last 7 days)", "Agree with the billed loaded miles", g.agreed, null],
      ["Truck positions and billed miles (last 7 days)", "Apart by more than 30%", g.apart, null],
      ["Fuel and fuel tax", "Settled fuel purchases in the window", h.fuelTax.purchases, null],
      ...h.fuelTax.issues.map((i): CsvCell[] => ["Fuel and fuel tax", i.label, i.count, null]),
      ...(h.fuelTax.quarter ? [["Fuel and fuel tax", `${h.fuelTax.quarter.quarter} IFTA return`, h.fuelTax.quarter.filed ? (h.fuelTax.quarter.changedSinceFiled ? "filed, changed since" : "filed") : `not filed, ${h.fuelTax.quarter.blockers.length} blocking`, null] as CsvCell[]] : []),
      // Money integrity (Wave 6 step 2): the same rows the card shows. A check not done says "not checked" and why, never a count.
      ...h.money.checks.flatMap((c): CsvCell[][] =>
        c.state === "not_checked"
          ? [[`Money: ${c.label}`, `Not checked: ${c.notCheckedWhy}`, null, null]]
          : [
              [`Money: ${c.label}`, "Records checked", c.checked, null],
              [`Money: ${c.label}`, "Agree", c.passed, null],
              [`Money: ${c.label}`, "Disagree", c.failed, null]
            ]
      )
    ];
    return { filename: `truelane-desk-data-health-checks-${tag}.csv`, csv: toCsv(["Check", "Measure", "Loads", "Dollars"], rows) };
  }

  // Cash beside gross (Wave 6 step 4): the card's figures, row for row. The route asks for the billing office.
  if (kind === "kpi-cash") {
    const p = parseKpiParams(query);
    const k = await getKpiCash({ period: p.period, compare: p.compare, filters: p.filters, terminals: termList(await currentTerminal()) }, now);
    return {
      filename: `truelane-desk-kpi-cash-${p.period}-${day}.csv`,
      csv: toCsv(["Group", "Measure", "Unit", "This period", "The period before"], cashFileRows(k).map((r): CsvCell[] => [r.group, r.measure, r.unit, r.now, r.before]))
    };
  }

  if (kind === "kpi-drivers" || kind === "kpi-lanes" || kind === "kpi-brokers" || kind === "kpi-weeks" || kind === "kpi-trucks") {
    const p = parseKpiParams(query);
    const k = await getDeskKpi({ period: p.period, compare: false, filters: p.filters, terminals: termList(await currentTerminal()) }, now);
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
          ["Lane", "Loads", "Gross", "Revenue per load", "Per revenue mile", "Loaded miles", "Empty miles before pickup", "Empty miles after delivery", "Total empty miles", "Total trip miles", "Empty miles (%)", "Avg empty before pickup", "Avg empty after delivery", "Loads with a market rate", "Against market (%)", "Target per load", "Vs target", "Scorecard", "Status"],
          k.lanes.map((l): CsvCell[] => [l.key, l.loads, two(l.gross), two(l.revPerLoad), two(l.rpm), two(l.loadedMiles), two(l.pickupEmptyMiles), two(l.returnEmptyMiles), two(l.pickupEmptyMiles + l.returnEmptyMiles), two(l.drivenMiles), pctOf(l.emptyShare), two(l.avgPickupEmpty), two(l.avgReturnEmpty), l.benchmarked, pctOf(l.marketVariancePct), l.targetRate == null ? "" : two(l.targetRate), l.vsTarget == null ? "" : two(l.vsTarget), l.score === "below" ? "BELOW" : l.score === "ok" ? "OK" : "NO TARGET", l.status === "above" ? "above market" : l.status === "below" ? "below market" : "no market rate"])
        )
      };
    }
    if (kind === "kpi-brokers") {
      return {
        filename: `truelane-desk-kpi-customers-${tag}.csv`,
        csv: toCsv(
          ["Customer", "Loads", "Gross", "Per revenue mile", "Against market (%)", "Loads with a market rate", "Paid invoices", "Days to pay", "Average wait at a stop (min)", "On time (%)", "Stops with an arrival and a window", "Books ahead (days)", "Rolled loads", "Cancelled or TONU"],
          k.brokers.map((b): CsvCell[] => [b.name, b.loads, two(b.gross), two(b.rpm), pctOf(b.marketVariancePct), b.benchmarked, b.paidLoads, two(b.avgDaysToPay), two(b.avgWaitMinutes), pctOf(b.onTimeArrivals), b.arrivalStops, two(b.leadDays), b.rolled, b.lost])
        )
      };
    }
    if (kind === "kpi-trucks") {
      return {
        filename: `truelane-desk-kpi-trucks-${tag}.csv`,
        csv: toCsv(
          ["Truck", "Loads", "Miles driven", "Empty miles", "Empty miles (%)"],
          k.trucks.map((r): CsvCell[] => [r.name, r.loads, two(r.drivenMiles), two(r.emptyMiles), pctOf(r.emptyShare)])
        )
      };
    }
    return {
      filename: `truelane-desk-kpi-weeks-${tag}.csv`,
      csv: toCsv(
        ["Week ending", "Gross", "Loads", "Per revenue mile", "Empty miles (%)", "Loaded miles", "Fuel surcharge", "Surcharge per loaded mile", "Surcharge of line haul (%)", "Diesel price"],
        k.trend.map((w): CsvCell[] => [ymd(new Date(w.end)), two(w.gross), w.loads, two(w.rpm), pctOf(w.emptyShare), two(w.loadedMiles), two(w.fsc), w.loadedMiles > 0 ? two(w.fsc / w.loadedMiles) : "", w.lineHaul > 0 ? pctOf(w.fsc / w.lineHaul) : "", w.diesel == null ? "" : two(w.diesel)])
      )
    };
  }

  return null;
}
