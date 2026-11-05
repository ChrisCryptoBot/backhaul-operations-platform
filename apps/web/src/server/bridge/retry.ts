import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { BRIDGE_ENV, bridgeConfig } from "./core";
import { flushBridgeOutbox } from "./service";
import { supabaseTransport } from "./transport";

/**
 * The dispatcher's Retry on a load whose delivery to the driver's phone failed: the failed (or waiting) items for that load are made due now and delivered at once, with the same flusher
 * the schedule uses. "nothing" when no item is waiting; "delivered" when the load's item went through; "failed" when the link still could not be reached (it keeps its own retries).
 */
export async function retryBridgeDelivery(loadId: string, workspaceId = currentWorkspaceId()): Promise<"nothing" | "delivered" | "failed"> {
  const items = await prisma.bridgeOutbox.findMany({ where: { workspaceId, loadId, status: { in: ["pending", "failed"] } }, select: { id: true } });
  if (items.length === 0) return "nothing";
  const cfg = bridgeConfig(process.env as Record<string, string | undefined>);
  if (!cfg) return "failed";
  // A manual retry is a fresh start: the attempts count again, and the wait is lifted.
  await prisma.bridgeOutbox.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  await flushBridgeOutbox(supabaseTransport(cfg), { workspaceId });
  const left = await prisma.bridgeOutbox.count({ where: { workspaceId, loadId, status: { in: ["pending", "failed"] } } });
  return left === 0 ? "delivered" : "failed";
}

export { BRIDGE_ENV };
