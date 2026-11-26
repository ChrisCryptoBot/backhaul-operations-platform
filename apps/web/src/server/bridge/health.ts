import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";

/** How long something can sit due on the driver link before the desk says the link is not running. */
export const STALL_MINUTES = 5;

/**
 * Whether the driver link has stopped running for this fleet: something has been due for the phones for longer than STALL_MINUTES and is still waiting. With the schedule running, a due
 * item is delivered within the minute, and one that could not be is pushed back (its next try is in the future), so an item overdue this long means nothing is calling the link at all.
 * Read from the outbox itself, so it needs nothing written by the schedule. Null for a fleet that is not on the link, or when nothing is overdue.
 */
export async function linkStall(workspaceId = currentWorkspaceId(), now = new Date()): Promise<{ minutes: number } | null> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return null;
  const oldest = await prisma.bridgeOutbox.findFirst({
    where: { workspaceId, status: "pending", nextAttemptAt: { lte: new Date(now.getTime() - STALL_MINUTES * 60_000) } },
    orderBy: { nextAttemptAt: "asc" },
    select: { nextAttemptAt: true }
  });
  return oldest ? { minutes: Math.floor((now.getTime() - oldest.nextAttemptAt.getTime()) / 60_000) } : null;
}
