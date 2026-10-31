import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { asHistoryFilter, asHistorySort, payRecord, PROFIT_SORT_WINDOW, PROFIT_SORTS, type HistoryFilter, type HistorySort, type PayRecord } from "@/lib/loads-history";
import { boardRowOf, loadInclude, type BoardRow } from "./queries";
import { currentWorkspaceId } from "./workspace";

/**
 * The Loads screen's History, a page at a time. A fleet has tens of thousands of finished loads, so the filter, the sort, the search and the counts are done by the
 * database; only the page being shown is read in full and priced. The rules are the same as lib/loads-history.ts (delivered, cancelled or paid a TONU; "owed" is
 * delivered and not paid; "cancelled" is cancelled or TONU; dated by delivery, else cancellation, else the scheduled day).
 */
export const HISTORY_PAGE_SIZE = 100;

export type HistoryQuery = {
  filter?: string;
  sort?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  /** Only this lane, "Origin → Destination". */
  lane?: string;
  /** The header's terminal: loads on that terminal's trucks or drivers, and loads not placed anywhere yet. Null or absent is every terminal. */
  terminal?: string | null;
  /** Rows only: no month totals and no customer record (a file being written does not need them). */
  lean?: boolean;
};
export type HistoryPage = {
  rows: BoardRow[];
  total: number;
  /** The three tab counts for the search, whatever the filter. */
  counts: Record<HistoryFilter, number>;
  filter: HistoryFilter;
  sort: HistorySort;
  page: number;
  pageSize: number;
  pages: number;
  /** How one customer has treated the desk, when the search names only one. */
  record: PayRecord | null;
  /** True when a profit sort ordered only the latest `windowSize` loads of a longer list. */
  windowed: boolean;
  windowSize: number;
  /** For each Dallas month in view: every finished load in it that matches (not just this page's), and what they earned. */
  months: Record<string, { loads: number; earned: number }>;
};

const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/**
 * One search word, as the set of load ids it matches: the load's own text, or the name of its truck, or the name of its driver. Three index-friendly
 * branches joined by `union` and used as `l.id in (...)`, so each trigram index can answer its own branch. (An `or` across the load's columns and a
 * joined truck's or driver's name cannot use any of them, and reads every load.)
 */
const termSql = (t: string, workspaceId: string) => {
  const p = like(t);
  return Prisma.sql`l.id in (
    select id from loads where workspace_id = ${workspaceId} and (load_number ilike ${p} or po_number ilike ${p} or invoice_number ilike ${p} or broker_name ilike ${p} or broker_mc_number ilike ${p} or origin_address ilike ${p} or destination_address ilike ${p})
    union select ld.id from loads ld join vehicles tv on tv.id = ld.vehicle_id where ld.workspace_id = ${workspaceId} and tv.name ilike ${p}
    union select ad.load_id from assignments ad join drivers dv on dv.id = ad.driver_id where dv.workspace_id = ${workspaceId} and dv.name ilike ${p})`;
};

/** The loads alone (counts, search, the customer's record); every filter and search above reads only the load's own columns. */
const FROM = Prisma.sql`from loads l`;
/** Plus what the "per mile" sort needs: the truck's cost profile. */
const FROM_PRICED = Prisma.sql`from loads l left join cost_profiles cp on cp.vehicle_id = l.vehicle_id`;
const DATED = Prisma.sql`coalesce(l.completed_at, l.cancelled_at, l.scheduled_date)`;
/** What a load earned (lib/load-gross.ts, in SQL): paid linehaul when entered else the agreed rate, plus surcharge and layover; a TONU is its fee; a cancelled load nothing. */
const GROSS = Prisma.sql`(case when l.status = 'cancelled' then 0 when l.status = 'tonu' then coalesce(l.tonu_revenue, 0) else (case when coalesce(l.actual_revenue, 0) > 0 then l.actual_revenue else l.quoted_revenue end) + coalesce(l.fuel_surcharge, 0) + coalesce(l.layover_pay, 0) end)`;
const PER_MILE = Prisma.sql`case when cp.id is null or l.status in ('tonu', 'cancelled') then null else ${GROSS} / nullif(l.pickup_deadhead_miles + l.loaded_miles + case when l.is_backhaul then 0 else l.return_deadhead_miles end, 0) end`;
/** The Dallas calendar month a load is dated in, "2026-10": the same grouping the page draws. Dates are stored as UTC wall-clock, so they are read as UTC first. */
const MONTH = Prisma.sql`to_char((${DATED} at time zone 'UTC') at time zone 'America/Chicago', 'YYYY-MM')`;

/**
 * The terminal scope in SQL: the same loads as queries.ts inTerminal (on a truck or with a driver of that terminal, or not placed anywhere yet). Written as sets the database builds once
 * (`in (select ...)`), not a correlated test per load, which read every finished load for each of the three conditions.
 */
const terminalSql = (terminal: string | null | undefined, workspaceId: string) =>
  terminal
    ? Prisma.sql` and (l.vehicle_id in (select tv.id from vehicles tv where tv.workspace_id = ${workspaceId} and tv.terminal = ${terminal})
        or l.id in (select ta.load_id from assignments ta join drivers td on td.id = ta.driver_id where td.workspace_id = ${workspaceId} and td.terminal = ${terminal})
        or (l.vehicle_id is null and l.id not in (select tn.load_id from assignments tn)))`
    : Prisma.empty;

function whereSql(workspaceId: string, q: string, lane?: string, terminal?: string | null) {
  const terms = q.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean).slice(0, 6);
  const [from, to] = lane ? lane.split(" → ") : [null, null];
  const laneSql = lane
    ? Prisma.sql` and l.origin_address ${from === "?" ? Prisma.sql`is null` : Prisma.sql`= ${from}`} and l.destination_address ${to === "?" ? Prisma.sql`is null` : Prisma.sql`= ${to}`}`
    : Prisma.empty;
  return Prisma.sql`l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status in ('completed', 'cancelled', 'tonu')${laneSql}${terminalSql(terminal, workspaceId)}${terms.length ? Prisma.sql` and ${Prisma.join(terms.map((t) => termSql(t, workspaceId)), " and ")}` : Prisma.empty}`;
}

/** lib/loads-history.ts isOwed, in SQL: delivered and not paid, or a TONU invoiced and not paid. */
const OWED = Prisma.sql`((l.status = 'completed' and coalesce(l.payment_status, '') <> 'paid') or (l.status = 'tonu' and l.payment_status = 'invoiced'))`;
const FILTER_SQL: Record<HistoryFilter, Prisma.Sql> = {
  all: Prisma.empty,
  owed: Prisma.sql` and ${OWED}`,
  cancelled: Prisma.sql` and l.status in ('cancelled', 'tonu')`
};

export async function listHistory(query: HistoryQuery = {}, workspaceId = currentWorkspaceId()): Promise<HistoryPage> {
  const filter = asHistoryFilter(query.filter);
  const sort = asHistorySort(query.sort);
  const q = query.q?.trim() ?? "";
  const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : HISTORY_PAGE_SIZE;
  const where = whereSql(workspaceId, q, query.lane, query.terminal);

  const [c] = await prisma.$queryRaw<Array<{ n_all: number; n_owed: number; n_cancelled: number }>>`
    select count(*)::int as n_all,
      count(*) filter (where ${OWED})::int as n_owed,
      count(*) filter (where l.status in ('cancelled', 'tonu'))::int as n_cancelled
    ${FROM} where ${where}`;
  const counts: Record<HistoryFilter, number> = { all: c?.n_all ?? 0, owed: c?.n_owed ?? 0, cancelled: c?.n_cancelled ?? 0 };
  const total = counts[filter];
  const pages = Math.max(1, new Prisma.Decimal(total).div(pageSize).ceil().toNumber());
  const page = Math.min(Math.max(1, query.page ?? 1), pages);

  const order =
    sort === "oldest" ? Prisma.sql`${DATED} asc nulls last, l.id`
    : sort === "pay" ? Prisma.sql`${GROSS} desc, ${DATED} desc nulls last, l.id`
    : sort === "permile" ? Prisma.sql`${PER_MILE} desc nulls last, ${DATED} desc nulls last, l.id`
    : Prisma.sql`${DATED} desc nulls last, l.id`;
  const byProfit = (PROFIT_SORTS as readonly string[]).includes(sort);
  let rows: BoardRow[];
  let windowed = false;
  if (byProfit) {
    // Net pay, profit a mile and $ an hour come from the truck's cost profile, so they are worked per load: the latest finished loads are priced and ordered, best first, and a load that
    // cannot be priced (no truck, a TONU, no fuel price) sinks to the bottom.
    const recent = await prisma.$queryRaw<Array<{ id: string }>>`
      select l.id ${FROM} where ${where}${FILTER_SQL[filter]} order by ${DATED} desc nulls last, l.id limit ${PROFIT_SORT_WINDOW}`;
    windowed = total > PROFIT_SORT_WINDOW;
    const all = recent.length ? await prisma.load.findMany({ where: { id: { in: recent.map((r) => r.id) } }, include: loadInclude }) : [];
    const byId = new Map(all.map((l) => [l.id, l]));
    const value = (r: BoardRow) => (sort === "net" ? r.netPay : sort === "profit" ? r.profitPerMile : r.profitPerHour);
    const priced = recent.map((r) => byId.get(r.id)).filter((l): l is NonNullable<typeof l> => !!l).map(boardRowOf);
    priced.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return y - x;
    });
    const start = (page - 1) * pageSize;
    rows = priced.slice(start, start + pageSize);
  } else {
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      select l.id ${sort === "permile" ? FROM_PRICED : FROM} where ${where}${FILTER_SQL[filter]} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`;
    const loads = ids.length ? await prisma.load.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: loadInclude }) : [];
    const byId = new Map(loads.map((l) => [l.id, l]));
    rows = ids.map((r) => byId.get(r.id)).filter((l): l is NonNullable<typeof l> => !!l).map(boardRowOf);
  }

  // "How this customer has treated the desk": only when something is searched, from the matching loads' money columns alone (capped).
  let record: PayRecord | null = null;
  if (q && !query.lean) {
    const money = await prisma.$queryRaw<Array<{ status: string; paymentStatus: string | null; brokerName: string | null; quotedRevenue: number; invoicedAt: Date | null; paidAt: Date | null; invoicedAmount: number | null; paidAmount: number | null }>>`
      select l.status, l.payment_status as "paymentStatus", l.broker_name as "brokerName", l.quoted_revenue::float8 as "quotedRevenue", l.invoiced_at as "invoicedAt", l.paid_at as "paidAt", l.invoiced_amount::float8 as "invoicedAmount", l.paid_amount::float8 as "paidAmount"
      ${FROM} where ${where} limit 5000`;
    record = payRecord(money.map((m) => ({ id: "", loadNumber: null, origin: null, destination: null, vehicleName: null, driverName: null, verdict: null, perMile: null, scheduledDate: null, completedAt: null, cancelledAt: null, ...m })));
  }
  // Month headers count the whole month for this filter and search, not only the rows on this page.
  const monthly = query.lean
    ? []
    : await prisma.$queryRaw<Array<{ month: string | null; n: number; earned: number }>>`
    select ${MONTH} as month, count(*)::int as n, coalesce(sum(case when l.status in ('completed', 'tonu') then ${GROSS} else 0 end), 0)::float8 as earned
    ${FROM} where ${where}${FILTER_SQL[filter]} group by 1`;
  const months = Object.fromEntries(monthly.map((m) => [m.month ?? "undated", { loads: m.n, earned: m.earned }]));
  return { rows, total, counts, filter, sort, page, pageSize, pages, record, months, windowed, windowSize: PROFIT_SORT_WINDOW };
}

/** How many finished loads match a search (the History tab's count when another tab is open). */
export async function countHistory(q = "", workspaceId = currentWorkspaceId(), terminal: string | null = null): Promise<number> {
  const [c] = await prisma.$queryRaw<Array<{ n: number }>>`select count(*)::int as n ${FROM} where ${whereSql(workspaceId, q.trim(), undefined, terminal)}`;
  return c?.n ?? 0;
}
