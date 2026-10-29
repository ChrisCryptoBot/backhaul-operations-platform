import { prisma } from "@/lib/db";
import { summarizeDetention, type DetentionSummary } from "@/lib/detention";
import { num, numOrNull } from "./convert";
import { getThresholds } from "./thresholds";
import { DEMO_WORKSPACE_ID } from "./workspace";

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

/** Every finished load that waited past its free time, newest first, with the total still unbilled. */
export async function getDetentionRecovery(workspaceId = DEMO_WORKSPACE_ID) {
  const [loads, thresholds] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, status: "completed" },
      include: { stops: true, vehicle: { include: { costProfile: true } } },
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
