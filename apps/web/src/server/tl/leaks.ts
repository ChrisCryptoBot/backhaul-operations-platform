import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DAY_MS, WEEK_MS, periodWindow, previousWindow, type KpiPeriod } from "@/lib/kpi-periods";
import { LEAKS, buildLeakLedger, dwellForgone, loadLeaks, type LeakItem, type LeakLedger, type OpenDwell } from "@/lib/leaks";
import { dwell } from "@/lib/telematics";
import { detentionOfLoad, waivedDetentionLoads } from "./detention";
import { numOrNull } from "./convert";
import { ALL_TIME_DAYS, getKpiRows, leakLoadOf } from "./kpi";
import { answerCache, clockBucket } from "./answer-cache";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";
import { terminalSetSql } from "./terminal-sql";

/**
 * The Leak Ledger's read (lib/leaks.ts has the rules). Takes the terminals in view as `terminals` (`null` is everything), so a region, a terminal or the whole fleet is one question; nothing here ever
 * reads another terminal's rows when one is asked for. Four reads, each for the window only: the finished loads (the KPI's own row reader, lean), detention on the loads that waited, trailer dwell waived or
 * lowered from the audit trail, and the trailers sitting past their free time right now. The finished answer is kept until the data under it moves (answer-cache.ts).
 */
export type LeakQuery = { period: KpiPeriod; compare?: boolean; terminals?: readonly string[] | null };

/** How far back the reads must reach: the period, the one before it for the comparison, and the twelve weeks of the table. */
export function ledgerSince(period: KpiPeriod, compare: boolean, nowMs: number, tz: string): number {
  const w = periodWindow(period, nowMs, tz);
  const prev = compare ? previousWindow(period, nowMs, tz) : null;
  const starts = [w.start ?? nowMs - ALL_TIME_DAYS * DAY_MS, prev?.start ?? null, nowMs - 12 * WEEK_MS].filter((x): x is number => x != null);
  return starts.reduce((lo, x) => (x < lo ? x : lo), nowMs);
}

/** Detention on loads that finished since `since`: still unbilled, waived on purpose (with the dollars it would have been), or waited-for with no rate to bill it at (unpriced). */
async function detentionItems(workspaceId: string, since: Date, terminals: readonly string[] | null): Promise<LeakItem[]> {
  const waited = await prisma.$queryRaw<Array<{ id: string }>>`
    select l.id from loads l
    where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since}
      and (l.dock_wait_minutes > 0 or exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes > 0))${terminalSetSql(terminals, workspaceId)}`;
  const ids = waited.map((w) => w.id);
  if (ids.length === 0) return [];
  const [loads, thresholds, waived] = await Promise.all([
    prisma.load.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        loadNumber: true,
        brokerName: true,
        originAddress: true,
        destinationAddress: true,
        completedAt: true,
        dockWaitMinutes: true,
        quotedRevenue: true,
        fuelSurcharge: true,
        invoicedAmount: true,
        invoiceLines: true,
        paymentStatus: true,
        snapshotDetentionRate: true,
        snapshotFreeGraceMinutes: true,
        stops: { select: { stopSequence: true, stopType: true, waitMinutes: true } },
        vehicle: { select: { name: true, costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } }
      }
    }),
    getThresholds(workspaceId),
    waivedDetentionLoads(ids, workspaceId)
  ]);
  const out: LeakItem[] = [];
  for (const l of loads) {
    const dt = detentionOfLoad(l, thresholds.detentionGraceMinutes);
    const base = { at: l.completedAt?.getTime() ?? 0, miles: 0, loadId: l.id, label: l.loadNumber ?? "A load", lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`, customer: l.brokerName, truck: l.vehicle?.name ?? null };
    if (waived.has(l.id)) {
      if (dt.unbilled > 0) out.push({ ...base, key: "detention_waived", dollars: dt.unbilled });
    } else if (dt.unbilled > 0) out.push({ ...base, key: "detention_unbilled", dollars: dt.unbilled });
    else if (dt.noRate) out.push({ ...base, key: "detention_unbilled", dollars: null });
  }
  return out;
}

/** Trailer dwell a person waived or lowered since `since`, from the audit trail's "Owed" before and after. History starts when the audit began recording these events. */
async function dwellItems(workspaceId: string, since: Date, terminals: readonly string[] | null): Promise<LeakItem[]> {
  const scope = terminals == null ? Prisma.empty : Prisma.sql` and t.terminal = any(${[...terminals]})`;
  const rows = await prisma.$queryRaw<Array<{ createdAt: Date; number: string; beforeOwed: string | null; afterOwed: string | null }>>`
    select e.created_at as "createdAt", t.number, e.before ->> 'Owed' as "beforeOwed", e.after ->> 'Owed' as "afterOwed"
    from audit_events e join trailers t on t.id = e.entity_id
    where e.workspace_id = ${workspaceId} and t.workspace_id = ${workspaceId} and e.action in ('dwell_waived', 'dwell_adjusted') and e.created_at >= ${since}${scope}`;
  const out: LeakItem[] = [];
  for (const r of rows) {
    const gave = dwellForgone(r.beforeOwed, r.afterOwed);
    if (gave != null) out.push({ key: "dwell_forgone", at: r.createdAt.getTime(), dollars: gave, miles: 0, loadId: null, label: r.number, lane: null, customer: null, truck: null });
  }
  return out;
}

/** Trailers sitting dropped past their free time right now, with what each owes at the company's terms (or the figure a person set). Not a dated leak, so it is shown apart from the weeks. */
async function openDwell(workspaceId: string, terminals: readonly string[] | null, nowMs: number): Promise<OpenDwell> {
  const [trailers, terms] = await Promise.all([
    prisma.trailer.findMany({
      where: { workspaceId, archivedAt: null, currentVehicleId: null, unhookedAt: { not: null }, ...(terminals == null ? {} : { terminal: { in: [...terminals] } }) },
      select: { id: true, number: true, unhookedAt: true, dwellRateOverride: true, dwellDaysOverride: true, dwellWaived: true }
    }),
    getThresholds(workspaceId)
  ]);
  const rows = trailers
    .map((t) => {
      const d = dwell(t.unhookedAt, nowMs, { freeHours: terms.dwellFreeHours, perDay: terms.dwellPerDayRate }, false, { ratePerDay: numOrNull(t.dwellRateOverride), billableDays: numOrNull(t.dwellDaysOverride), waived: t.dwellWaived });
      return { id: t.id, number: t.number, sinceMs: t.unhookedAt!.getTime(), owed: d?.amount ?? 0 };
    })
    .filter((r) => r.owed > 0)
    .sort((a, b) => b.owed - a.owed || a.number.localeCompare(b.number));
  const cents = rows.reduce((s, r) => s.plus(new Prisma.Decimal(r.owed)), new Prisma.Decimal(0));
  return { dollars: cents.toDecimalPlaces(2).toNumber(), trailers: rows.length, rows: rows.slice(0, 10) };
}

const answers = answerCache<LeakLedger>();
/** Tests clear it between cases. */
export const clearLeakCache = () => answers.clear();

export async function getLeakLedger(q: LeakQuery, now = new Date(), workspaceId = currentWorkspaceId()): Promise<LeakLedger> {
  const compare = q.compare ?? true;
  const terminals = q.terminals == null ? null : [...new Set(q.terminals)].sort();
  const [thresholds, tz] = await Promise.all([getThresholds(workspaceId), workspaceTimezone(workspaceId)]);
  return answers.remember([workspaceId, q.period, compare, terminals, clockBucket(now.getTime(), 3_600_000), thresholds, tz], workspaceId, async () => {
    const since = new Date(ledgerSince(q.period, compare, now.getTime(), tz));
    const [rows, detention, dwellLost, open] = await Promise.all([getKpiRows(workspaceId, { since, finishedOnly: true, terminals }), detentionItems(workspaceId, since, terminals), dwellItems(workspaceId, since, terminals), openDwell(workspaceId, terminals, now.getTime())]);
    const items: LeakItem[] = [...rows.flatMap((r) => loadLeaks(leakLoadOf(r))), ...detention, ...dwellLost];
    return buildLeakLedger(items, { period: q.period, compare, openDwell: open }, now.getTime(), tz);
  });
}

/** The ledger's leak keys, in the order the screen and the file list them. */
export const LEDGER_KEYS = LEAKS.map((l) => l.key);
