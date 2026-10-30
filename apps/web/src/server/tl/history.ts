import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { asHistoryFilter, asHistorySort, payRecord, type HistoryFilter, type HistorySort, type PayRecord } from "@/lib/loads-history";
import { boardRowOf, loadInclude, type BoardRow } from "./queries";
import { currentWorkspaceId } from "./workspace";

/**
 * The Loads screen's History, a page at a time. A fleet has tens of thousands of finished loads, so the filter, the sort, the search and the counts are done by the
 * database; only the page being shown is read in full and priced. The rules are the same as lib/loads-history.ts (delivered, cancelled or paid a TONU; "owed" is
 * delivered and not paid; "cancelled" is cancelled or TONU; dated by delivery, else cancellation, else the scheduled day).
 */
export const HISTORY_PAGE_SIZE = 100;

export type HistoryQuery = { filter?: string; sort?: string; q?: string; page?: number; pageSize?: number; /** Only this lane, "Origin → Destination". */ lane?: string };
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
const PER_MILE = Prisma.sql`case when cp.id is null then null else (l.quoted_revenue + coalesce(l.fuel_surcharge, 0)) / nullif(l.pickup_deadhead_miles + l.loaded_miles + case when l.is_backhaul then 0 else l.return_deadhead_miles end, 0) end`;

function whereSql(workspaceId: string, q: string, lane?: string) {
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const [from, to] = lane ? lane.split(" → ") : [null, null];
  const laneSql = lane
    ? Prisma.sql` and l.origin_address ${from === "?" ? Prisma.sql`is null` : Prisma.sql`= ${from}`} and l.destination_address ${to === "?" ? Prisma.sql`is null` : Prisma.sql`= ${to}`}`
    : Prisma.empty;
  return Prisma.sql`l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status in ('completed', 'cancelled', 'tonu')${laneSql}${terms.length ? Prisma.sql` and ${Prisma.join(terms.map((t) => termSql(t, workspaceId)), " and ")}` : Prisma.empty}`;
}

const FILTER_SQL: Record<HistoryFilter, Prisma.Sql> = {
  all: Prisma.empty,
  owed: Prisma.sql` and l.status = 'completed' and coalesce(l.payment_status, '') <> 'paid'`,
  cancelled: Prisma.sql` and l.status in ('cancelled', 'tonu')`
};

export async function listHistory(query: HistoryQuery = {}, workspaceId = currentWorkspaceId()): Promise<HistoryPage> {
  const filter = asHistoryFilter(query.filter);
  const sort = asHistorySort(query.sort);
  const q = query.q?.trim() ?? "";
  const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : HISTORY_PAGE_SIZE;
  const where = whereSql(workspaceId, q, query.lane);

  const [c] = await prisma.$queryRaw<Array<{ n_all: number; n_owed: number; n_cancelled: number }>>`
    select count(*)::int as n_all,
      count(*) filter (where l.status = 'completed' and coalesce(l.payment_status, '') <> 'paid')::int as n_owed,
      count(*) filter (where l.status in ('cancelled', 'tonu'))::int as n_cancelled
    ${FROM} where ${where}`;
  const counts: Record<HistoryFilter, number> = { all: c?.n_all ?? 0, owed: c?.n_owed ?? 0, cancelled: c?.n_cancelled ?? 0 };
  const total = counts[filter];
  const pages = Math.max(1, new Prisma.Decimal(total).div(pageSize).ceil().toNumber());
  const page = Math.min(Math.max(1, query.page ?? 1), pages);

  const order =
    sort === "oldest" ? Prisma.sql`${DATED} asc nulls last, l.id`
    : sort === "pay" ? Prisma.sql`l.quoted_revenue desc, ${DATED} desc nulls last, l.id`
    : sort === "permile" ? Prisma.sql`${PER_MILE} desc nulls last, ${DATED} desc nulls last, l.id`
    : Prisma.sql`${DATED} desc nulls last, l.id`;
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    select l.id ${sort === "permile" ? FROM_PRICED : FROM} where ${where}${FILTER_SQL[filter]} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`;
  const loads = ids.length ? await prisma.load.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: loadInclude }) : [];
  const byId = new Map(loads.map((l) => [l.id, l]));
  const rows = ids.map((r) => byId.get(r.id)).filter((l): l is NonNullable<typeof l> => !!l).map(boardRowOf);

  // "How this customer has treated the desk": only when something is searched, from the matching loads' money columns alone (capped).
  let record: PayRecord | null = null;
  if (q) {
    const money = await prisma.$queryRaw<Array<{ status: string; paymentStatus: string | null; brokerName: string | null; quotedRevenue: number; invoicedAt: Date | null; paidAt: Date | null; invoicedAmount: number | null; paidAmount: number | null }>>`
      select l.status, l.payment_status as "paymentStatus", l.broker_name as "brokerName", l.quoted_revenue::float8 as "quotedRevenue", l.invoiced_at as "invoicedAt", l.paid_at as "paidAt", l.invoiced_amount::float8 as "invoicedAmount", l.paid_amount::float8 as "paidAmount"
      ${FROM} where ${where} limit 5000`;
    record = payRecord(money.map((m) => ({ id: "", loadNumber: null, origin: null, destination: null, vehicleName: null, driverName: null, verdict: null, perMile: null, scheduledDate: null, completedAt: null, cancelledAt: null, ...m })));
  }
  return { rows, total, counts, filter, sort, page, pageSize, pages, record };
}

/** How many finished loads match a search (the History tab's count when another tab is open). */
export async function countHistory(q = "", workspaceId = currentWorkspaceId()): Promise<number> {
  const [c] = await prisma.$queryRaw<Array<{ n: number }>>`select count(*)::int as n ${FROM} where ${whereSql(workspaceId, q.trim())}`;
  return c?.n ?? 0;
}
