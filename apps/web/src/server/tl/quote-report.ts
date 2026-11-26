import { prisma } from "@/lib/db";
import { buildQuoteReport, type DecisionRow, type QuoteReport, type VerdictKey } from "@/lib/quote-report";
import { periodWindow, type KpiPeriod } from "@/lib/kpi-periods";
import { cityState } from "@/lib/city-state";
import { num } from "./convert";
import type { DecisionDetails } from "./quote";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";
import { currentActorId } from "./identity";
import { checkAccess } from "./access";
import { can } from "@/lib/roles";
import type { Terminals } from "@/lib/scope";
import { inTerminal } from "./terminal-sql";

/** The most decisions a report reads: a desk that decides more than this in a period gets the latest of them, and the page says so. */
export const REPORT_LIMIT = 5000;

const KINDS = ["accepted", "overridden", "passed"] as const;

/**
 * The decisions on quotes in a period, as report rows. `by` limits them to one person's (a dispatcher sees their own; an admin sees everyone's). Reads the decision and its load,
 * never writes.
 */
/** One person's decisions: by their id, and by their name for decisions made before ids were kept (those have none). */
export type ReportPerson = { id: string | null; name: string };

export async function listQuoteDecisions(opts: { period: KpiPeriod; by?: ReportPerson | null; terminals?: Terminals }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ rows: DecisionRow[]; capped: boolean }> {
  const win = periodWindow(opts.period, now.getTime(), await workspaceTimezone(workspaceId));
  const found = await prisma.loadDecision.findMany({
    where: {
      decisionType: { in: [...KINDS] },
      ...(opts.by ? { OR: [...(opts.by.id ? [{ decidedById: opts.by.id }] : []), { decidedById: null, decidedBy: opts.by.name }] } : {}),
      decidedAt: { ...(win.start != null ? { gte: new Date(win.start) } : {}), lte: new Date(win.end) },
      // The terminals in view, as every report on the desk follows them (a quote not on a truck yet is everyone's).
      load: { workspaceId, deletedAt: null, ...inTerminal(opts.terminals ?? null) }
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

export async function getQuoteReport(opts: { period: KpiPeriod; by?: ReportPerson | null; terminals?: Terminals }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ report: QuoteReport; rows: DecisionRow[]; capped: boolean }> {
  const { rows, capped } = await listQuoteDecisions(opts, now, workspaceId);
  return { report: buildQuoteReport(rows), rows, capped };
}

/**
 * Whose decisions the person asking may see: an admin sees everyone's, a dispatcher only their own, everyone else none. The role is the member table's (checkAccess), not the session
 * cookie's, so a person whose role was lowered sees less on their next click. Returns the person to filter to, "all" for no filter, or null when they may not see the report.
 */
export async function reportScope(): Promise<ReportPerson | "all" | null> {
  const a = await checkAccess("read");
  if (!a.ok) return null;
  const me = a.identity;
  if (can(me.role, me.grants, "admin")) return "all";
  if (!can(me.role, me.grants, "quote")) return null;
  // Outside a request there is nobody to filter to; the demo desk's own person has a "demo:" id.
  return { id: currentActorId(), name: me.name };
}
