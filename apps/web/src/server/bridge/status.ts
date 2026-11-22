import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { statusPlan, toStatusRow, type DriverStatusRow } from "@/lib/driver-status";
import type { BridgeTransport } from "./transport";

/**
 * The HOS read mirror (Wallet + Bridge plan, Phase 2 step 4). The desk already keeps each driver's clocks from its ELD on `Driver` (hosDriveMinutes, hosShiftMinutes,
 * hosCycleMinutes, hosSyncedAt; written by syncEld in server/partners/eld.ts). This copies them, driver-safe, to the phone project's `bridge.driver_status` for drivers whose
 * phone is connected: one read of what the bridge has, then a write only for rows that changed, and a delete for phones no longer connected. Idempotent: running it twice
 * writes nothing the second time. Runs from the bridge cron, so a sync that happened while the link was down is mirrored on the next run.
 */
export async function mirrorDriverStatus(transport: BridgeTransport, opts: { workspaceId?: string } = {}): Promise<{ written: number; removed: number }> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return { written: 0, removed: 0 };
  const orgId = ws.bridgeOrgId;
  const drivers = await prisma.driver.findMany({
    where: { workspaceId, active: true, phoneUserId: { not: null } },
    select: { id: true, phoneUserId: true, hosDriveMinutes: true, hosShiftMinutes: true, hosCycleMinutes: true, hosSyncedAt: true, assignedVehicle: { select: { name: true } } }
  });
  const next = drivers
    .map((d) => toStatusRow(orgId, { ...d, unitName: d.assignedVehicle?.name ?? null }))
    .filter((r): r is DriverStatusRow => r != null);
  const there = await transport.driverStatusRows(orgId);
  const plan = statusPlan(next, there);
  if (plan.write.length > 0) await transport.upsertDriverStatus(plan.write);
  if (plan.remove.length > 0) await transport.deleteDriverStatus(orgId, plan.remove);
  return { written: plan.write.length, removed: plan.remove.length };
}
