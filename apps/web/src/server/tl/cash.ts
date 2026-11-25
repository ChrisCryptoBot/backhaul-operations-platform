import { prisma } from "@/lib/db";
import { cashMoves, openBalance, periodCash, type CashInvoice, type CashMoves, type PeriodCash } from "@/lib/cash";
import { hasFilters, type KpiFilters } from "@/lib/kpi-params";
import { DAY_MS, periodWindow, previousWindow, weekBuckets, type KpiPeriod, type TimeWindow } from "@/lib/kpi-periods";
import { decimalCents } from "@/lib/money-integrity";
import { answerCache, clockBucket } from "./answer-cache";
import { ALL_TIME_DAYS } from "./kpi";
import { MAX_AGO } from "./moves";
import { terminalSetSql } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * Cash's read (money plan Wave 6 step 4; lib/cash.ts has the rules). Invoices (not credit memos, not void) that issued, were paid, funded, released or charged back since `since`, and every open one
 * (for what is still owed now). An invoice belongs to a view when every load on it does: the terminals in view (the same rule as every scoped read) and the dashboard's filters (lane, customer,
 * driver, truck, read off the loads the way the KPI reads them). One with loads both in and out of the view, or with no load, cannot be put in it whole and is left out and counted, never split
 * or guessed at; an invoice wholly elsewhere is simply not this view's. Workspace-scoped, capped, exact cents (Decimal.toFixed(2) to whole cents).
 */
export const MAX_CASH_INVOICES = 20_000;

const c = (v: { toFixed(n: number): string } | null | undefined) => decimalCents(v == null ? null : v.toFixed(2));
const ms = (v: Date | null | undefined) => (v ? v.getTime() : null);
const laneOf = (o: string | null, dst: string | null) => `${o ?? "?"} → ${dst ?? "?"}`;

export type CashRead = { invoices: CashInvoice[]; /** Invoices left out because their loads are both in and out of the view, or they carry no load. */ leftOut: number; truncated: boolean };

export async function readCashInvoices(workspaceId: string, since: Date, terminals: readonly string[] | null, filters: KpiFilters = {}): Promise<CashRead> {
  const rows = await prisma.invoice.findMany({
    where: {
      workspaceId,
      kind: "invoice",
      status: { not: "void" },
      OR: [
        { status: "open" },
        { issuedAt: { gte: since } },
        { paidAt: { gte: since } },
        { factoringFundedAt: { gte: since } },
        { factoringReserveReleasedAt: { gte: since } },
        { factoringChargedBackAt: { gte: since } },
        { payments: { some: { paidAt: { gte: since } } } }
      ]
    },
    select: {
      id: true, number: true, status: true, issuedAt: true, total: true, paidTotal: true, paidAt: true, writeOffAmount: true, writeOffCode: true, billToName: true,
      factoringStatus: true, factoringFundedAt: true, factoringAdvance: true, factoringFee: true, factoringReserveReleased: true, factoringChargeback: true, factoringReserveReleasedAt: true, factoringChargedBackAt: true, factoringUpdatedAt: true,
      payments: { select: { id: true, amount: true, paidAt: true, source: true }, orderBy: [{ paidAt: "asc" }, { id: "asc" }] },
      loads: { select: { load: { select: { id: true, originAddress: true, destinationAddress: true, brokerName: true, vehicle: { select: { name: true } }, assignment: { select: { driver: { select: { name: true } } } } } } } },
      supplementOf: { select: { loads: { select: { load: { select: { id: true, originAddress: true, destinationAddress: true, brokerName: true, vehicle: { select: { name: true } }, assignment: { select: { driver: { select: { name: true } } } } } } } } } }
    },
    orderBy: [{ issuedAt: "desc" }, { id: "asc" }],
    take: MAX_CASH_INVOICES + 1
  });
  const truncated = rows.length > MAX_CASH_INVOICES;
  const kept = rows.slice(0, MAX_CASH_INVOICES);
  const scoped = terminals != null;
  const filtered = hasFilters(filters);
  const loadsOfInvoice = (i: (typeof kept)[number]) => (i.loads.length > 0 ? i.loads : (i.supplementOf?.loads ?? [])).map((x) => x.load);
  let inScope: Set<string> | null = null;
  if (scoped) {
    const ids = [...new Set(kept.flatMap((i) => loadsOfInvoice(i).map((l) => l.id)))];
    inScope = ids.length === 0 ? new Set() : new Set((await prisma.$queryRaw<Array<{ id: string }>>`select l.id from loads l where l.workspace_id = ${workspaceId} and l.id = any(${ids})${terminalSetSql(terminals, workspaceId)}`).map((r) => r.id));
  }
  type L = (typeof kept)[number]["loads"][number]["load"];
  const passes = (l: L) =>
    (!inScope || inScope.has(l.id)) &&
    (!filters.lane || laneOf(l.originAddress, l.destinationAddress) === filters.lane) &&
    (!filters.broker || l.brokerName === filters.broker) &&
    (!filters.driver || l.assignment?.driver.name === filters.driver) &&
    (!filters.truck || l.vehicle?.name === filters.truck);

  let leftOut = 0;
  const invoices: CashInvoice[] = [];
  for (const i of kept) {
    const loads = loadsOfInvoice(i);
    if (scoped || filtered) {
      if (loads.length === 0) {
        leftOut += 1;
        continue;
      }
      const n = loads.filter(passes).length;
      if (n === 0) continue;
      if (n < loads.length) {
        leftOut += 1;
        continue;
      }
    }
    const only = loads.length === 1 ? loads[0]! : null;
    invoices.push({
      id: i.id,
      number: i.number,
      status: i.status,
      issuedAt: i.issuedAt.getTime(),
      totalCents: c(i.total)!,
      paidTotalCents: c(i.paidTotal)!,
      paidAt: ms(i.paidAt),
      writeOffCents: c(i.writeOffAmount),
      writeOffCode: i.writeOffCode,
      factoring: {
        status: i.factoringStatus,
        fundedAt: ms(i.factoringFundedAt),
        advanceCents: c(i.factoringAdvance),
        feeCents: c(i.factoringFee),
        releasedCents: c(i.factoringReserveReleased),
        chargebackCents: c(i.factoringChargeback),
        releasedAt: ms(i.factoringReserveReleasedAt),
        chargedBackAt: ms(i.factoringChargedBackAt),
        updatedAt: ms(i.factoringUpdatedAt)
      },
      payments: i.payments.map((p) => ({ id: p.id, cents: c(p.amount)!, at: p.paidAt.getTime(), source: p.source })),
      customer: i.billToName,
      lane: only ? laneOf(only.originAddress, only.destinationAddress) : null
    });
  }
  return { invoices, leftOut, truncated };
}

export type KpiCash = {
  window: TimeWindow;
  previous: TimeWindow | null;
  current: PeriodCash;
  prior: PeriodCash | null;
  open: ReturnType<typeof openBalance>;
  leftOut: number;
  truncated: boolean;
};

const kpiAnswers = answerCache<KpiCash>(120);
const moveAnswers = answerCache<CashMoves & { leftOut: number; truncated: boolean }>(60);
/** Tests clear them between cases. */
export const clearCashCache = () => {
  kpiAnswers.clear();
  moveAnswers.clear();
};

/** The KPI dashboard's cash: the period (and the one before when compared), what is still owed now, and what could not be placed in the view. */
export async function getKpiCash(q: { period: KpiPeriod; compare?: boolean; filters?: KpiFilters; terminals?: readonly string[] | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<KpiCash> {
  const tz = await workspaceTimezone(workspaceId);
  const compare = q.compare ?? true;
  const filters = q.filters ?? {};
  const terminals = q.terminals == null ? null : [...new Set(q.terminals)].sort();
  return kpiAnswers.remember([workspaceId, q.period, compare, filters, terminals, clockBucket(now.getTime(), 3_600_000), tz], workspaceId, async () => {
    const window = periodWindow(q.period, now.getTime(), tz);
    const previous = compare ? previousWindow(q.period, now.getTime(), tz) : null;
    const since = new Date(Math.min(window.start ?? now.getTime() - ALL_TIME_DAYS * DAY_MS, previous?.start ?? Number.POSITIVE_INFINITY));
    const r = await readCashInvoices(workspaceId, since, terminals, filters);
    return { window, previous, current: periodCash(r.invoices, window, tz), prior: previous ? periodCash(r.invoices, previous, tz) : null, open: openBalance(r.invoices), leftOut: r.leftOut, truncated: r.truncated };
  });
}

/** Why it moved, on cash: the same two weeks the gross bridge reads (`ago` weeks back), by lane or customer, for the terminals in view. */
export async function getCashMoves(q: { ago?: number; by?: "lane" | "customer"; terminals?: readonly string[] | null }, now = new Date(), workspaceId = currentWorkspaceId()) {
  const ago = q.ago != null && Number.isInteger(q.ago) && q.ago >= 0 && q.ago <= MAX_AGO ? q.ago : 0;
  const by = q.by === "customer" ? "customer" : "lane";
  const terminals = q.terminals == null ? null : [...new Set(q.terminals)].sort();
  const tz = await workspaceTimezone(workspaceId);
  return moveAnswers.remember([workspaceId, ago, by, terminals, clockBucket(now.getTime(), 3_600_000), tz], workspaceId, async () => {
    const weeks = weekBuckets(now.getTime(), MAX_AGO + 2, tz);
    const after = weeks[weeks.length - 1 - ago]!;
    const before = weeks[weeks.length - 2 - ago]!;
    const r = await readCashInvoices(workspaceId, new Date(before.start), terminals);
    return { ...cashMoves(r.invoices, before, after, by, tz), leftOut: r.leftOut, truncated: r.truncated };
  });
}
