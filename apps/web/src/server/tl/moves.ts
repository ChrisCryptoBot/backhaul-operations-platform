import { prisma } from "@/lib/db";
import { weekBuckets } from "@/lib/kpi-periods";
import { bridgeOf, changeOf, moveRows, totalsOf, withoutCosts, type Bridge, type MoveBy, type MoveLoad, type MoveRow, type WeekTotals } from "@/lib/moves";
import { answerCache, clockBucket } from "./answer-cache";
import { detentionOfLoad } from "./detention";
import { getKpiRows, moveLoadOf } from "./kpi";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * "Why it moved" (lib/moves.ts has the math and says what each effect means). Two trailing seven-day weeks of the finished loads, the same weeks the dashboard's trend draws: `ago` is how many weeks back the later
 * one ends (0 is the week ending now). The loads are the KPI's own rows with the KPI's own money and mile definitions; the detention billed comes from the invoices, read only for the loads of those two weeks. The
 * terminals in view narrow the loads before anything is added up, so a person limited to a terminal never sees another's figures. Kept until the data under it moves (answer-cache.ts).
 */
export const MOVE_ROWS = 25;
export const MAX_AGO = 10;

export type MovesQuery = { ago?: number; by?: MoveBy; terminals?: readonly string[] | null };

export type WeekWindow = { start: number; end: number; label: string };
export type Moves = {
  ago: number;
  by: MoveBy;
  before: WeekWindow;
  after: WeekWindow;
  desk: { before: WeekTotals; after: WeekTotals; bridge: Bridge };
  rows: MoveRow[];
  /** The rows past the first `MOVE_ROWS`: how many, and what they changed by together. */
  more: { count: number; change: number };
  /** Loads with no fuel, tolls or other cost recorded, in each week: the cost lines read low when there are many. */
  noCosts: { before: number; after: number };
};

const answers = answerCache<Moves>(60);
/** Tests clear it between cases. */
export const clearMovesCache = () => answers.clear();

export async function getMoves(q: MovesQuery = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<Moves> {
  const ago = q.ago != null && Number.isInteger(q.ago) && q.ago >= 0 && q.ago <= MAX_AGO ? q.ago : 0;
  const by: MoveBy = q.by === "customer" ? "customer" : "lane";
  const terminals = q.terminals == null ? null : [...new Set(q.terminals)].sort();
  const [thresholds, tz] = await Promise.all([getThresholds(workspaceId), workspaceTimezone(workspaceId)]);
  return answers.remember([workspaceId, ago, by, terminals, clockBucket(now.getTime(), 3_600_000), thresholds.detentionGraceMinutes, tz], workspaceId, async () => {
    const weeks = weekBuckets(now.getTime(), MAX_AGO + 2, tz);
    const after = weeks[weeks.length - 1 - ago]!;
    const before = weeks[weeks.length - 2 - ago]!;
    const rows = await getKpiRows(workspaceId, { since: new Date(before.start), finishedOnly: true, terminals });
    const loads = rows.map((r) => moveLoadOf(r)).filter((l) => l.doneAt > before.start && l.doneAt <= after.end);

    // What was billed as detention, for the loads that have an invoice (the rest billed none). The same reading the Invoices and Leak Ledger screens make of a load.
    const ids = loads.map((l) => l.loadId);
    const billed = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      const found = await prisma.load.findMany({
        where: { workspaceId, id: { in: part }, paymentStatus: { in: ["invoiced", "paid"] } },
        select: {
          id: true,
          dockWaitMinutes: true,
          quotedRevenue: true,
          fuelSurcharge: true,
          invoicedAmount: true,
          invoiceLines: true,
          paymentStatus: true,
          snapshotDetentionRate: true,
          snapshotFreeGraceMinutes: true,
          stops: { select: { stopSequence: true, stopType: true, waitMinutes: true } },
          vehicle: { select: { costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } }
        }
      });
      for (const l of found) {
        const d = detentionOfLoad(l, thresholds.detentionGraceMinutes).billedExtra;
        if (d > 0) billed.set(l.id, d);
      }
    }
    const withDetention: MoveLoad[] = loads.map((l) => ({ ...l, detention: billed.get(l.loadId) ?? 0 }));
    const a = withDetention.filter((l) => l.doneAt <= before.end);
    const b = withDetention.filter((l) => l.doneAt > before.end);
    const all = moveRows(a, b, by);
    const shown = all.slice(0, MOVE_ROWS);
    const rest = all.slice(MOVE_ROWS);
    const deskBefore = totalsOf(a);
    const deskAfter = totalsOf(b);
    return {
      ago,
      by,
      before,
      after,
      desk: { before: deskBefore, after: deskAfter, bridge: bridgeOf(deskBefore, deskAfter) },
      rows: shown,
      more: { count: rest.length, change: changeOf(rest) },
      noCosts: { before: withoutCosts(a), after: withoutCosts(b) }
    };
  });
}
