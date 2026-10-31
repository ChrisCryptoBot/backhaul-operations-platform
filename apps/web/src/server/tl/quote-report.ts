import { prisma } from "@/lib/db";
import { buildQuoteReport, type DecisionRow, type QuoteReport, type VerdictKey } from "@/lib/quote-report";
import { periodWindow, type KpiPeriod } from "@/lib/kpi-periods";
import { cityState } from "@/lib/city-state";
import { num } from "./convert";
import type { DecisionDetails } from "./quote";
import { currentWorkspaceId } from "./workspace";
import { sessionIdentity } from "./identity";
import { roleAtLeast } from "@/lib/roles";

/** The most decisions a report reads: a desk that decides more than this in a period gets the latest of them, and the page says so. */
export const REPORT_LIMIT = 5000;

const KINDS = ["accepted", "overridden", "passed"] as const;

/**
 * The decisions on quotes in a period, as report rows. `by` limits them to one person's (a dispatcher sees their own; an owner sees everyone's). Reads the decision and its load,
 * never writes.
 */
export async function listQuoteDecisions(opts: { period: KpiPeriod; by?: string | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ rows: DecisionRow[]; capped: boolean }> {
  const win = periodWindow(opts.period, now.getTime());
  const found = await prisma.loadDecision.findMany({
    where: {
      decisionType: { in: [...KINDS] },
      ...(opts.by ? { decidedBy: opts.by } : {}),
      decidedAt: { ...(win.start != null ? { gte: new Date(win.start) } : {}), lte: new Date(win.end) },
      load: { workspaceId, deletedAt: null }
    },
    include: { load: { select: { brokerName: true, originAddress: true, destinationAddress: true, quotedRevenue: true } } },
    orderBy: { decidedAt: "desc" },
    take: REPORT_LIMIT + 1
  });
  const rows: DecisionRow[] = found.slice(0, REPORT_LIMIT).map((d) => {
    const x = (d.details && typeof d.details === "object" && !Array.isArray(d.details) ? (d.details as Partial<DecisionDetails>) : null);
    const lane = `${cityState(d.load.originAddress) ?? "?"} to ${cityState(d.load.destinationAddress) ?? "?"}`;
    return {
      id: d.id,
      at: d.decidedAt,
      kind: d.decisionType as DecisionRow["kind"],
      by: d.decidedBy ?? "Not recorded",
      reason: d.overrideReason,
      notes: d.overrideNotes,
      customer: x?.customer ?? d.load.brokerName,
      lane: x?.lane ?? lane,
      offer: x?.offer ?? num(d.load.quotedRevenue),
      verdict: (x?.verdict as VerdictKey | undefined) ?? null,
      benchmark: x?.benchmark ?? null,
      marginPerMile: x?.marginPerMile ?? null,
      leftOver: x?.leftOver ?? null,
      marketVariancePct: x?.marketVariancePct ?? null,
      firstOffer: x?.firstOffer ?? null,
      truck: x?.truck ?? null,
      fuelPrice: x?.fuelPrice ?? null,
      fuelSource: x?.fuelSource ?? null
    };
  });
  return { rows, capped: found.length > REPORT_LIMIT };
}

export async function getQuoteReport(opts: { period: KpiPeriod; by?: string | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ report: QuoteReport; rows: DecisionRow[]; capped: boolean }> {
  const { rows, capped } = await listQuoteDecisions(opts, now, workspaceId);
  return { report: buildQuoteReport(rows), rows, capped };
}

/**
 * Whose decisions the person asking may see: an owner (and the demo, with sign-in off) sees everyone's, a dispatcher only their own, a viewer none. Returns the name to filter to,
 * "all" for no filter, or null when they may not see the report at all.
 */
export function reportScope(): string | "all" | null {
  const me = sessionIdentity();
  if (!me) return "all";
  if (roleAtLeast(me.role, "owner")) return "all";
  return roleAtLeast(me.role, "dispatcher") ? me.name : null;
}
