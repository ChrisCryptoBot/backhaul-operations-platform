import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { deskBodyOf, isPullable, toDriverRow } from "@/lib/driver-messages";
import { driverMode } from "./outbox";
import type { BridgeTransport } from "./transport";

/**
 * Driver messages over the bridge (Phase 2 step 3; the carrier owns the record, D4). The desk's Thread/Message stay the record; the bridge carries them:
 * - out: `sendMessage` queues a `message` outbox row in the same transaction as the desk message (bridged drivers only); the leased flush (./service) delivers it here and stamps
 *   the desk message's `deliveredAt`;
 * - in: `pullDriverMessages` takes the phone's rows into the desk thread (the bridge row id is the desk message's clientId, so a pull that runs twice keeps one copy), stamps them
 *   delivered on the bridge, and carries read marks both ways.
 * Files: the desk's files stay on the desk (the phone is told how many); the phone's files are named in the text until the desk fetches them (open item).
 */
type Tx = Prisma.TransactionClient;

/** Queue a desk message for the driver's phone, inside the transaction that saves it. Nothing for a driver who is not bridged. */
export async function enqueueMessage(tx: Tx, i: { workspaceId: string; driverId: string; messageId: string; now?: Date }): Promise<boolean> {
  const mode = await driverMode(i.driverId, i.workspaceId, tx);
  if (mode.mode !== "bridged") return false;
  const driver = await tx.driver.findFirstOrThrow({ where: { id: i.driverId, workspaceId: i.workspaceId }, select: { phoneUserId: true } });
  await tx.bridgeOutbox.create({ data: { workspaceId: i.workspaceId, loadId: null, kind: "message", messageId: i.messageId, phoneUserId: driver.phoneUserId!, nextAttemptAt: i.now ?? new Date() } });
  return true;
}

/**
 * Put one desk message on the bridge. Null when there is nothing to send (the message is gone, or the driver's phone is not the one it was queued for: they unlinked or relinked).
 * A re-delivery of the same message returns the row already there (client id = the desk Message.id).
 */
export async function deliverDriverMessage(transport: BridgeTransport, orgId: string, workspaceId: string, item: { messageId: string | null; phoneUserId: string }): Promise<{ rowId: string; messageId: string } | null> {
  if (!item.messageId) return null;
  const m = await prisma.message.findFirst({
    where: { id: item.messageId, direction: "out", thread: { workspaceId } },
    select: { id: true, body: true, load: { select: { loadNumber: true } }, _count: { select: { attachments: true } }, thread: { select: { driver: { select: { id: true, phoneUserId: true } } } } }
  });
  if (!m || m.thread.driver.phoneUserId !== item.phoneUserId) return null;
  const row = await transport.insertDriverMessage(
    toDriverRow({ orgId, phoneUserId: item.phoneUserId, deskDriverId: m.thread.driver.id, messageId: m.id, body: m.body, fileCount: m._count.attachments, loadNumber: m.load?.loadNumber ?? null })
  );
  return { rowId: row.id, messageId: m.id };
}

export type MessagePullResult = { taken: number; ignored: number; readByDriver: number; readOnDesk: number };

/** Read marks look this far back (a dispatcher opening a thread weeks later still tells the phone). */
const READ_WINDOW_DAYS = 30;

/**
 * Take the phone's messages into the desk, at least once and idempotent. A row from a phone no driver on this desk holds is left on the bridge (counted as ignored), never guessed at.
 * Then the read marks: the driver's reads of desk messages land on the desk's out messages (`readAt`), and the dispatcher's reads of the driver's messages go to the bridge (`read_at`).
 */
export async function pullDriverMessages(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<MessagePullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const res: MessagePullResult = { taken: 0, ignored: 0, readByDriver: 0, readOnDesk: 0 };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return res;
  const orgId = ws.bridgeOrgId;

  const rows = (await transport.driverMessagesToDesk(orgId, opts.limit ?? 200)).filter((r) => isPullable(r, orgId));
  const taken: string[] = [];
  for (const row of rows) {
    const driver = await prisma.driver.findFirst({ where: { workspaceId, phoneUserId: row.driver_sub }, select: { id: true } });
    if (!driver) {
      res.ignored += 1;
      continue;
    }
    const sentAt = new Date(row.created_at);
    await prisma.$transaction(async (tx) => {
      const thread = await tx.thread.upsert({ where: { driverId: driver.id }, update: {}, create: { workspaceId, driverId: driver.id } });
      const again = await tx.message.findUnique({ where: { threadId_clientId: { threadId: thread.id, clientId: row.id } }, select: { id: true } });
      if (again) return;
      await tx.message.create({ data: { threadId: thread.id, direction: "in", body: deskBodyOf(row), clientId: row.id, sentAt, deliveredAt: now } });
      await tx.thread.update({ where: { id: thread.id }, data: { lastMessageAt: sentAt > thread.lastMessageAt ? sentAt : thread.lastMessageAt } });
    });
    taken.push(row.id);
    res.taken += 1;
  }
  await transport.stampDriverMessages(orgId, taken, "delivered_at", now);

  const since = new Date(now.getTime() - READ_WINDOW_DAYS * 86_400_000);
  // The driver read what the desk sent.
  const unreadOut = await prisma.message.findMany({ where: { direction: "out", deliveredAt: { not: null }, readAt: null, sentAt: { gte: since }, thread: { workspaceId } }, select: { id: true }, take: 100 });
  if (unreadOut.length > 0) {
    const reads = await transport.readByDriver(orgId, unreadOut.map((m) => m.id));
    for (const r of reads) {
      const w = await prisma.message.updateMany({ where: { id: r.client_id, direction: "out", readAt: null }, data: { readAt: new Date(r.read_at) } });
      res.readByDriver += w.count;
    }
  }
  // The dispatcher read what the driver sent (the desk keeps the bridge row id as the message's clientId).
  const readIn = await prisma.message.findMany({ where: { direction: "in", readAt: { not: null, gte: since }, clientId: { not: null }, thread: { workspaceId } }, select: { clientId: true }, take: 100, orderBy: { readAt: "desc" } });
  const ids = readIn.map((m) => m.clientId!).filter(Boolean);
  if (ids.length > 0) {
    await transport.stampDriverMessages(orgId, ids, "read_at", now);
    res.readOnDesk = ids.length;
  }
  return res;
}
