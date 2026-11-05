import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { bridgeConfig, bridgeMode, type BridgeMode } from "./core";

/**
 * Telling the phone, the part the desk's own transactions call: whether a driver is bridged, and the queue of what still has to be delivered. It imports nothing from the dispatch code, so
 * dispatch, disruptions and edits can call it without a cycle; delivery and reading are in ./service.
 */
type Tx = Prisma.TransactionClient;

/** Whether this server holds what the driver link needs (read now, never kept). */
export const bridgeServerReady = (): boolean => bridgeConfig(process.env as Record<string, string | undefined>) != null;

/** How a load's driver is reached: through the bridge, or by the dispatcher recording their answers (today's way), and why. */
export async function driverMode(driverId: string, workspaceId = currentWorkspaceId(), db: Tx | typeof prisma = prisma): Promise<BridgeMode> {
  const [ws, driver] = await Promise.all([db.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } }), db.driver.findFirst({ where: { id: driverId, workspaceId }, select: { phoneUserId: true } })]);
  return bridgeMode({ workspaceOrgId: ws?.bridgeOrgId ?? null, serverReady: bridgeServerReady(), driverPhoneUserId: driver?.phoneUserId ?? null });
}

export type OutboxKind = "dispatch" | "update" | "reassign_old" | "cancel";

/** Write what has to be told to the phone, inside the transaction of the desk change it follows: both happen or neither does. A fleet that is not bridged gets nothing. */
export async function enqueueBridge(tx: Tx, i: { workspaceId: string; loadId: string; kind: OutboxKind; driverId: string; dispatchId?: string | null; now?: Date }): Promise<boolean> {
  const mode = await driverMode(i.driverId, i.workspaceId, tx);
  if (mode.mode !== "bridged") return false;
  const driver = await tx.driver.findFirstOrThrow({ where: { id: i.driverId, workspaceId: i.workspaceId }, select: { phoneUserId: true } });
  await tx.bridgeOutbox.create({ data: { workspaceId: i.workspaceId, loadId: i.loadId, kind: i.kind, phoneUserId: driver.phoneUserId!, dispatchId: i.dispatchId ?? null, nextAttemptAt: i.now ?? new Date() } });
  return true;
}

/** The assignment statuses a driver's phone is holding: sent, accepted or on the road. A draft was never sent, a declined or finished one is not on the phone any more. */
const ON_THE_PHONE = ["dispatched", "accepted", "in_progress"];

/** Tell the phone about a change to a load that is on it (a cancel, a change of time or details): looks the assignment up inside the transaction, and queues nothing when it was never sent. */
export async function enqueueForLoad(tx: Tx, i: { workspaceId: string; loadId: string; kind: OutboxKind; now?: Date }): Promise<boolean> {
  const a = await tx.assignment.findFirst({ where: { loadId: i.loadId, load: { workspaceId: i.workspaceId } }, select: { driverId: true, status: true } });
  if (!a || !ON_THE_PHONE.includes(a.status)) return false;
  return enqueueBridge(tx, { workspaceId: i.workspaceId, loadId: i.loadId, kind: i.kind, driverId: a.driverId, now: i.now });
}


export type LinkState = { mode: BridgeMode; /** The item still waiting or given up on, if any. */ item: { status: string; attempts: number; lastError: string | null } | null };

/** Where a load's driver stands on the driver link: how they are reached, and whether a delivery to their phone is waiting, being retried or has been given up on. */
export async function linkStateFor(loadId: string, driverId: string, workspaceId = currentWorkspaceId()): Promise<LinkState> {
  const mode = await driverMode(driverId, workspaceId);
  if (mode.mode !== "bridged") return { mode, item: null };
  const item = await prisma.bridgeOutbox.findFirst({ where: { loadId, workspaceId, status: { in: ["pending", "failed"] } }, orderBy: { createdAt: "desc" }, select: { status: true, attempts: true, lastError: true } });
  return { mode, item };
}
