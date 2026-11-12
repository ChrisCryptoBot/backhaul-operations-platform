import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DAY_MS, WEEK_MS, periodWindow, previousWindow, type KpiPeriod } from "@/lib/kpi-periods";
import { termsFor, type LeakIntake } from "@/lib/leak-intake";
import { LEAKS, NO_COVERAGE, buildLeakLedger, dwellForgone, loadLeaks, type LeakItem, type LeakLedger, type LedgerCoverage, type OpenDwell } from "@/lib/leaks";
import { batchOfChannel } from "@/lib/load-import";
import { dwell } from "@/lib/telematics";
import { detentionOfLoad, waivedDetentionLoads } from "./detention";
import { numOrNull } from "./convert";
import { ALL_TIME_DAYS, getKpiRows, leakLoadOf } from "./kpi";
import { answerCache, clockBucket } from "./answer-cache";
import { getLeakIntake } from "./leak-intake";
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

/**
 * Detention on loads that finished since `since`: still unbilled, waived on purpose (with the dollars it would have been), or waited-for with no rate to bill it at (unpriced).
 * A load booked on the desk is priced at the terms frozen on it, else its truck's profile. An imported load has neither, so it is priced from the intake's terms (its customer's, else the fleet's)
 * from the stop times its file carried, as its own lines; its truck's profile today is never used. A load whose file carried no stop times has no wait to price and appears in `coverage`, not here.
 */
async function detentionItems(workspaceId: string, since: Date, terminals: readonly string[] | null, intake: LeakIntake): Promise<LeakItem[]> {
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
        channel: true,
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
    const imported = batchOfChannel(l.channel) != null;
    const terms = imported ? termsFor(intake, l.brokerName, thresholds.detentionGraceMinutes) : null;
    // An imported load's terms are the intake's alone: frozen terms and the truck's profile are cleared, so nothing but the carrier's own figure can price it.
    const dt = detentionOfLoad(terms ? { ...l, snapshotDetentionRate: terms.rate, snapshotFreeGraceMinutes: terms.freeMinutes, vehicle: null } : l, thresholds.detentionGraceMinutes);
    const base = { at: l.completedAt?.getTime() ?? 0, miles: 0, loadId: l.id, label: l.loadNumber ?? "A load", lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`, customer: l.brokerName, truck: l.vehicle?.name ?? null, basisNote: terms?.note ?? null };
    if (waived.has(l.id)) {
      if (dt.unbilled > 0) out.push({ ...base, key: imported ? "detention_waived_intake" : "detention_waived", dollars: dt.unbilled });
    } else if (dt.unbilled > 0) out.push({ ...base, key: imported ? "detention_unbilled_intake" : "detention_unbilled", dollars: dt.unbilled });
    else if (dt.noRate) out.push({ ...base, key: imported ? "detention_unbilled_intake" : "detention_unbilled", dollars: null });
  }
  return out;
}

/**
 * Imported loads finished since `since`, and how many of them carry no wait at any stop: their file had no stop times, so detention cannot be checked on them and nothing is estimated. A few are named
 * (newest first) so they can be found. Counted apart from the ledger's items, because for these loads we do not know whether a leak exists.
 */
async function coverageOf(workspaceId: string, since: Date, terminals: readonly string[] | null): Promise<LedgerCoverage> {
  const scope = terminalSetSql(terminals, workspaceId);
  const [counts, sample] = await Promise.all([
    prisma.$queryRaw<Array<{ n: number; blind: number }>>`
      select count(*)::int as n, (count(*) filter (where not exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes is not null)))::int as blind
      from loads l
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since} and l.channel like 'import:%'${scope}`,
    prisma.$queryRaw<Array<{ id: string; label: string | null }>>`
      select l.id, l.load_number as label from loads l
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since} and l.channel like 'import:%'${scope}
        and not exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes is not null)
      order by l.completed_at desc, l.id limit 10`
  ]);
  const c = counts[0];
  if (!c || c.n === 0) return NO_COVERAGE;
  return { importedLoads: c.n, noStopTimes: { loads: c.blind, sample: sample.map((r) => ({ loadId: r.id, label: r.label ?? "A load" })) } };
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
  const [thresholds, tz, intake] = await Promise.all([getThresholds(workspaceId), workspaceTimezone(workspaceId), getLeakIntake(workspaceId)]);
  // The intake is part of the kept answer's key: a figure changed on the intake screen is never answered from the old numbers.
  return answers.remember([workspaceId, q.period, compare, terminals, clockBucket(now.getTime(), 3_600_000), thresholds, tz, intake], workspaceId, async () => {
    const since = new Date(ledgerSince(q.period, compare, now.getTime(), tz));
    const windowStart = periodWindow(q.period, now.getTime(), tz).start;
    const [rows, detention, dwellLost, open, coverage] = await Promise.all([
      getKpiRows(workspaceId, { since, finishedOnly: true, terminals }),
      detentionItems(workspaceId, since, terminals, intake),
      dwellItems(workspaceId, since, terminals),
      openDwell(workspaceId, terminals, now.getTime()),
      coverageOf(workspaceId, new Date(windowStart ?? since.getTime()), terminals)
    ]);
    const items: LeakItem[] = [...rows.flatMap((r) => loadLeaks(leakLoadOf(r), intake)), ...detention, ...dwellLost];
    return buildLeakLedger(items, { period: q.period, compare, openDwell: open, coverage }, now.getTime(), tz);
  });
}

/** The ledger's leak keys, in the order the screen and the file list them. */
export const LEDGER_KEYS = LEAKS.map((l) => l.key);
