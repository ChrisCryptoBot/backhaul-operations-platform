import { prisma } from "@/lib/db";
import { summarizeDetention, type DetentionSummary } from "@/lib/detention";
import { num, numOrNull } from "./convert";
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
};

type LoadForDetention = {
  stops: Array<{ stopSequence: number; stopType: string; waitMinutes: number | null }>;
  dockWaitMinutes: number | null;
  quotedRevenue: unknown;
  fuelSurcharge: unknown;
  invoicedAmount: unknown;
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
    invoice: { invoiced: l.paymentStatus === "invoiced" || l.paymentStatus === "paid", invoicedAmount: numOrNull(l.invoicedAmount as never), quotedRevenue: num(l.quotedRevenue as never), fuelSurcharge: numOrNull(l.fuelSurcharge as never) }
  });
}

/** Detention can be billed for this long after delivery; older loads are not read for it (a fleet has far too many to scan every visit). */
export const DETENTION_WINDOW_DAYS = 90;

/** Every finished load of the last 90 days that waited past its free time, newest first, with the total still unbilled. */
export async function getDetentionRecovery(workspaceId = currentWorkspaceId(), now = new Date()) {
  const since = new Date(now.getTime() - DETENTION_WINDOW_DAYS * 86_400_000);
  // Only a load somebody waited on can have detention (a wait of nothing is never past the free time), so the database names those loads first and only they are read in full.
  const waited = await prisma.$queryRaw<Array<{ id: string }>>`
    select l.id from loads l
    where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since}
      and (l.dock_wait_minutes > 0 or exists (select 1 from stops s where s.load_id = l.id and s.wait_minutes > 0))`;
  const [loads, thresholds] = await Promise.all([
    waited.length === 0
      ? Promise.resolve([])
      : prisma.load.findMany({
          where: { id: { in: waited.map((w) => w.id) } },
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
            paymentStatus: true,
            snapshotDetentionRate: true,
            snapshotFreeGraceMinutes: true,
            stops: { select: { stopSequence: true, stopType: true, waitMinutes: true } },
            vehicle: { select: { costProfile: { select: { detentionHourlyRate: true, freeGraceMinutes: true } } } }
          },
          orderBy: { completedAt: "desc" }
        }),
    getThresholds(workspaceId)
  ]);
  const rows: DetentionRow[] = loads
    .map((l) => ({
      ...detentionOfLoad(l, thresholds.detentionGraceMinutes),
      loadId: l.id,
      loadNumber: l.loadNumber,
      broker: l.brokerName,
      lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
      completedAt: l.completedAt,
      invoiced: l.paymentStatus === "invoiced" || l.paymentStatus === "paid"
    }))
    .filter((r) => r.billable > 0 || r.noRate);
  const owed = rows.filter((r) => r.unbilled > 0);
  return {
    rows,
    totalUnbilled: owed.reduce((s, r) => s + r.unbilled, 0),
    unbilledLoads: owed.length,
    totalBilled: rows.reduce((s, r) => s + r.billedExtra, 0),
    withoutRate: rows.filter((r) => r.noRate).length
  };
}
