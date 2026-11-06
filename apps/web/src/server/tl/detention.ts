import type { Terminals } from "@/lib/scope";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { summarizeDetention, type DetentionSummary } from "@/lib/detention";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { terminalSql } from "./terminal-sql";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/** Detention on finished loads, from each stop's recorded wait and the truck's detention terms (TrueLane's rule, lib/detention.ts). */
export type DetentionRow = DetentionSummary & {
  loadId: string;
  loadNumber: string | null;
  broker: string | null;
  lane: string;
  completedAt: Date | null;
  invoiced: boolean;
  waivedReason: string | null;
};

type LoadForDetention = {
  stops: Array<{ stopSequence: number; stopType: string; waitMinutes: number | null }>;
  dockWaitMinutes: number | null;
  quotedRevenue: unknown;
  fuelSurcharge: unknown;
  invoicedAmount: unknown;
  invoiceLines?: unknown;
  paymentStatus: string | null;
  /** Terms frozen on the load when it was booked; they win over the truck's profile as it is today. */
  snapshotDetentionRate?: unknown;
  snapshotFreeGraceMinutes?: number | null;
  vehicle: { costProfile: { detentionHourlyRate: unknown; freeGraceMinutes: number | null } | null } | null;
};

/** One load's detention, given the workspace's free time. `rate` is null when the truck has no detention rate on its cost profile. */
export function detentionOfLoad(l: LoadForDetention, workspaceGraceMinutes: number): DetentionSummary {
  const profile = l.vehicle?.costProfile ?? null;
  return summarizeDetention({
    stops: l.stops.map((s) => ({ stopSequence: s.stopSequence, stopType: s.stopType, waitMinutes: s.waitMinutes })),
    dockWaitMinutes: l.dockWaitMinutes,
    rate: numOrNull(l.snapshotDetentionRate as never) ?? numOrNull(profile?.detentionHourlyRate as never),
    graceMinutes: l.snapshotFreeGraceMinutes ?? profile?.freeGraceMinutes ?? null,
    workspaceGraceMinutes,
    invoice: { invoiced: l.paymentStatus === "invoiced" || l.paymentStatus === "paid", invoicedAmount: numOrNull(l.invoicedAmount as never), quotedRevenue: num(l.quotedRevenue as never), fuelSurcharge: numOrNull(l.fuelSurcharge as never), lines: Array.isArray(l.invoiceLines) ? (l.invoiceLines as Array<{ label: string; amount: number }>) : null }
  });
}

/** Which of these loads have had their unbilled detention waived on purpose, with the latest reason given. */
export async function waivedDetentionLoads(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (loadIds.length === 0) return out;
  const events = await prisma.auditEvent.findMany({
    where: { workspaceId, action: "detention_waived", loadId: { in: loadIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { loadId: true, reason: true }
  });
  for (const e of events) if (e.loadId && !out.has(e.loadId)) out.set(e.loadId, e.reason ?? "Waived");
  return out;
}

/**
 * Mark a load's unbilled detention as waived (for example, the customer refused it or it was forgiven for the relationship), with a reason kept in the audit trail. Once waived, it no
 * longer raises the unbilled-detention alert or sits on the Invoices recovery card. Bumps the load's timestamp so kept answers (alerts) refresh immediately.
 */
export async function waiveDetention(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: boolean; error?: string }> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the detention is not being billed." };
  const [load, thresholds, already] = await Promise.all([
    prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: true, vehicle: { include: { costProfile: true } } } }),
    getThresholds(workspaceId),
    waivedDetentionLoads([loadId], workspaceId)
  ]);
  if (!load || load.status !== "completed") return { ok: false, error: "Only a delivered load has detention to waive." };
  if (already.has(loadId)) return { ok: false, error: "Detention on this load was already marked as waived." };
  const dt = detentionOfLoad(load, thresholds.detentionGraceMinutes);
  if (!(dt.unbilled > 0)) return { ok: false, error: "There is no unbilled detention on this load." };
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { updatedAt: now } });
    await recordAudit(
      {
        entity: "invoice",
        action: "detention_waived",
        loadId,
        loadNumber: load.loadNumber,
        summary: `$${dt.unbilled.toFixed(2)} of detention waived${load.brokerName ? ` (${load.brokerName})` : ""}`,
        reason: why,
        before: { "Unbilled detention": `$${dt.unbilled.toFixed(2)}` },
        after: { "Unbilled detention": "Waived" },
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true };
}

/** Detention can be billed for this long after delivery; older loads are not read for it (a fleet has far too many to scan every visit). */
export const DETENTION_WINDOW_DAYS = 90;

/** Every finished load of the last 90 days that waited past its free time, newest first, with the total still unbilled. */
export async function getDetentionRecovery(workspaceId = currentWorkspaceId(), now = new Date(), terminal: Terminals = null) {
  const since = new Date(now.getTime() - DETENTION_WINDOW_DAYS * 86_400_000);
  // Only a load somebody waited on can have detention (a wait of nothing is never past the free time), so the database names those loads first and only they are read in full.
  const waited = await prisma.$queryRaw<Array<{ id: string }>>`
    select l.id from loads l
    where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since}
      and (l.dock_wait_minutes > 0 or exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes > 0))${terminalSql(terminal, workspaceId)}`;
  const ids = waited.map((w) => w.id);
  const [loads, thresholds, waived] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : prisma.load.findMany({
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
            vehicle: { select: { costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } }
          },
          orderBy: { completedAt: "desc" }
        }),
    getThresholds(workspaceId),
    waivedDetentionLoads(ids, workspaceId)
  ]);
  const rows: DetentionRow[] = loads
    .map((l) => {
      const dt = detentionOfLoad(l, thresholds.detentionGraceMinutes);
      const waivedReason = waived.get(l.id) ?? null;
      return {
        ...dt,
        unbilled: waivedReason ? 0 : dt.unbilled,
        loadId: l.id,
        loadNumber: l.loadNumber,
        broker: l.brokerName,
        lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
        completedAt: l.completedAt,
        invoiced: l.paymentStatus === "invoiced" || l.paymentStatus === "paid",
        waivedReason
      };
    })
    .filter((r) => (r.billable > 0 && !r.waivedReason) || r.noRate);
  const owed = rows.filter((r) => r.unbilled > 0);
  const sumCents = (list: DetentionRow[], pick: (r: DetentionRow) => number) => list.reduce((s, r) => s.plus(new Prisma.Decimal(pick(r))), new Prisma.Decimal(0)).toDecimalPlaces(2).toNumber();
  return {
    rows,
    totalUnbilled: sumCents(owed, (r) => r.unbilled),
    unbilledLoads: owed.length,
    totalBilled: sumCents(rows, (r) => r.billedExtra),
    withoutRate: rows.filter((r) => r.noRate).length
  };
}
