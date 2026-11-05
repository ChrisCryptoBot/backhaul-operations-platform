import { prisma } from "@/lib/db";
import type { DieselPoint, KpiExtras, RolledEvent, TenderRow } from "@/lib/kpi-extras";
import { numOrNull } from "./convert";

/**
 * What the KPI reads besides the finished loads: loads moved to a new pickup time (audit events), offers received and what became of them (quotes and their decisions), each lane's target
 * rate, and the weekly diesel price. Each is read for one workspace (the diesel price is public and shared). `kpiExtrasStamp` is a few counts and dates, cheap enough to read on every visit, so a
 * kept KPI answer is rebuilt when any of these moves.
 */
export async function getKpiExtras(workspaceId: string, since: Date): Promise<KpiExtras> {
  const [events, decisions, openQuotes, targets, diesel] = await Promise.all([
    prisma.auditEvent.findMany({ where: { workspaceId, action: "rescheduled", loadId: { not: null }, createdAt: { gte: since } }, select: { loadId: true, createdAt: true, reason: true } }),
    prisma.loadDecision.findMany({ where: { decidedAt: { gte: since }, load: { workspaceId } }, select: { decisionType: true, decidedAt: true } }),
    prisma.load.findMany({ where: { workspaceId, status: "quote", deletedAt: null, createdAt: { gte: since }, decisions: { none: {} } }, select: { createdAt: true } }),
    prisma.laneTarget.findMany({ where: { workspaceId }, select: { lane: true, targetRate: true } }),
    prisma.dieselPrice.findMany({ where: { region: "NUS" }, orderBy: { weekOf: "desc" }, take: 80, select: { weekOf: true, price: true } })
  ]);
  const rolled: RolledEvent[] = events.map((e) => ({ loadId: e.loadId!, at: e.createdAt.getTime(), reason: e.reason }));
  const tenders: TenderRow[] = [
    ...decisions.map((d) => ({ at: d.decidedAt.getTime(), kind: (d.decisionType === "passed" ? "passed" : "booked") as TenderRow["kind"] })),
    ...openQuotes.map((q) => ({ at: q.createdAt.getTime(), kind: "open" as const }))
  ];
  const laneTargets = new Map<string, number>();
  for (const t of targets) {
    const n = numOrNull(t.targetRate);
    if (n != null) laneTargets.set(t.lane, n);
  }
  const points: DieselPoint[] = diesel.flatMap((d) => {
    const n = numOrNull(d.price);
    return n == null ? [] : [{ weekOf: d.weekOf, price: n }];
  });
  return { rolled, tenders, laneTargets, diesel: points };
}

/** Counts and newest dates of everything `getKpiExtras` reads, as one string: it changes when any of it does. */
export async function kpiExtrasStamp(workspaceId: string): Promise<string> {
  const [m] = await prisma.$queryRaw<Array<{ r: bigint; rl: Date | null; d: bigint; dl: Date | null; q: bigint; ql: Date | null; t: bigint; tl: Date | null; p: bigint }>>`
    select (select count(*) from audit_events where workspace_id = ${workspaceId} and action = 'rescheduled') as r,
      (select max(created_at) from audit_events where workspace_id = ${workspaceId} and action = 'rescheduled') as rl,
      (select count(*) from load_decisions ld join loads l on l.id = ld.load_id where l.workspace_id = ${workspaceId}) as d,
      (select max(ld.updated_at) from load_decisions ld join loads l on l.id = ld.load_id where l.workspace_id = ${workspaceId}) as dl,
      (select count(*) from loads where workspace_id = ${workspaceId} and status = 'quote' and deleted_at is null) as q,
      (select max(updated_at) from loads where workspace_id = ${workspaceId} and status = 'quote') as ql,
      (select count(*) from lane_targets where workspace_id = ${workspaceId}) as t,
      (select max(updated_at) from lane_targets where workspace_id = ${workspaceId}) as tl,
      (select count(*) from diesel_prices) as p`;
  return [m?.r, m?.rl, m?.d, m?.dl, m?.q, m?.ql, m?.t, m?.tl, m?.p].map((x) => (x instanceof Date ? x.getTime() : String(x ?? 0))).join(":");
}
