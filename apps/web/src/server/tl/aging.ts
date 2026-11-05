import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { workspaceTimezone } from "./zone";
import { answerCache, clockBucket } from "./answer-cache";
import { terminalSql } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";

/**
 * What is owed and how late, as one aggregate the database works out: the invoices still out, what each still owes (the invoice less what has come in), and how many days past due each is
 * on the desk's own calendar (Dallas), the same rule as lib/overdue.ts. Nothing is read into the server: a fleet can have thousands out at once, and this is asked on every page (the
 * header's overdue count), so the answer is kept until the loads change or the hour turns. The Invoices screen's tiles and the header read this one answer, so they cannot differ, and
 * `terminal` narrows it the way it narrows the lists beside it.
 */
export type AgingBucket = { count: number; amount: number };
export type Aging = {
  count: number;
  totalOutstanding: number;
  overdueCount: number;
  overdueAmount: number;
  /** Days past due for the most overdue invoice; null when none is past due. */
  oldestDaysOverdue: number | null;
  /** When none is past due: calendar days until the soonest due date (0 = due today). Else null. */
  nextDueInDays: number | null;
  /** By how late each is: not yet due, and 1-30, 31-60, 61-90 and over 90 days past due. */
  buckets: { current: AgingBucket; d1_30: AgingBucket; d31_60: AgingBucket; d61_90: AgingBucket; d90plus: AgingBucket };
};

const answers = answerCache<Aging>(20);
export const clearAgingCache = () => answers.clear();

const BILLED = Prisma.sql`coalesce(l.invoiced_amount, case when l.status = 'tonu' then coalesce(l.tonu_revenue, 0) else l.quoted_revenue + coalesce(l.fuel_surcharge, 0) end)`;

export async function agingSummary(now = Date.now(), workspaceId = currentWorkspaceId(), terminal: string | null = null): Promise<Aging> {
  // Aging is counted on the carrier's own calendar (a day ends at the carrier's midnight), read from the workspace, never from a cookie.
  const tz = await workspaceTimezone(workspaceId);
  return answers.remember([workspaceId, terminal, tz, clockBucket(now, 900_000)], workspaceId, async () => {
    const [r] = await prisma.$queryRaw<
      Array<{ n: number; total: number | null; overdue_n: number; overdue_amount: number | null; oldest: number | null; next_due: number | null; c_n: number; c_a: number | null; a_n: number; a_a: number | null; b_n: number; b_a: number | null; c2_n: number; c2_a: number | null; d_n: number; d_a: number | null }>
    >`
      with o as (
        select greatest(${BILLED} - coalesce(l.paid_amount, 0), 0)::float8 as owing,
          case when l.invoiced_at is null then null
            else ((l.invoiced_at at time zone 'UTC') at time zone ${tz})::date + coalesce(l.pay_terms_days, 0) end as due,
          (${new Date(now)}::timestamp at time zone 'UTC' at time zone ${tz})::date as today
        from loads l
        where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status <> 'quote' and l.payment_status = 'invoiced' ${terminalSql(terminal, workspaceId)}
      ), d as (select owing, due, today, (today - due) as late from o)
      select count(*)::int as n, coalesce(sum(owing), 0)::float8 as total,
        (count(*) filter (where late > 0))::int as overdue_n, coalesce(sum(owing) filter (where late > 0), 0)::float8 as overdue_amount,
        (max(late) filter (where late > 0))::int as oldest, (min(-late) filter (where late <= 0))::int as next_due,
        (count(*) filter (where late is null or late <= 0))::int as c_n, coalesce(sum(owing) filter (where late is null or late <= 0), 0)::float8 as c_a,
        (count(*) filter (where late between 1 and 30))::int as a_n, coalesce(sum(owing) filter (where late between 1 and 30), 0)::float8 as a_a,
        (count(*) filter (where late between 31 and 60))::int as b_n, coalesce(sum(owing) filter (where late between 31 and 60), 0)::float8 as b_a,
        (count(*) filter (where late between 61 and 90))::int as c2_n, coalesce(sum(owing) filter (where late between 61 and 90), 0)::float8 as c2_a,
        (count(*) filter (where late > 90))::int as d_n, coalesce(sum(owing) filter (where late > 90), 0)::float8 as d_a
      from d`;
    const cents = (n: number | null) => new Prisma.Decimal(n ?? 0).toDecimalPlaces(2).toNumber();
    const b = (n: number, a: number | null): AgingBucket => ({ count: n, amount: cents(a) });
    const overdueCount = r?.overdue_n ?? 0;
    return {
      count: r?.n ?? 0,
      totalOutstanding: cents(r?.total ?? 0),
      overdueCount,
      overdueAmount: cents(r?.overdue_amount ?? 0),
      oldestDaysOverdue: overdueCount > 0 ? (r?.oldest ?? null) : null,
      nextDueInDays: overdueCount > 0 || (r?.n ?? 0) === 0 ? null : (r?.next_due ?? null),
      buckets: { current: b(r?.c_n ?? 0, r?.c_a ?? 0), d1_30: b(r?.a_n ?? 0, r?.a_a ?? 0), d31_60: b(r?.b_n ?? 0, r?.b_a ?? 0), d61_90: b(r?.c2_n ?? 0, r?.c2_a ?? 0), d90plus: b(r?.d_n ?? 0, r?.d_a ?? 0) }
    };
  });
}
