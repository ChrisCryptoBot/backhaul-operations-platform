import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { ATTACHMENTS_PER_MESSAGE, checkAttachment } from "@/lib/attachments";
import { attachmentPathAllowed, BRIDGE_KEEP_MS, deskBodyOf, fileNameOf, isPullable, toDriverRow, type DriverMessageRow, type NotKept, type SentFile } from "@/lib/driver-messages";
import { deskFilePath } from "@/lib/load-documents";
import { readFile, removeFiles, storeFile } from "@/server/tl/message-files";
import { storageRefusal } from "@/server/tl/storage";
import { driverMode } from "./outbox";
import type { BridgeTransport } from "./transport";

/**
 * Driver messages over the bridge (Phase 2 step 3; the carrier owns the record, D4). The desk's Thread/Message stay the record; the bridge carries them:
 * - out: `sendMessage` queues a `message` outbox row in the same transaction as the desk message (bridged drivers only); the leased flush (./service) delivers it here and stamps
 *   the desk message's `deliveredAt`;
 * - in: `pullDriverMessages` takes the phone's rows into the desk thread (the bridge row id is the desk message's clientId, so a pull that runs twice keeps one copy), stamps them
 *   delivered on the bridge, and carries read marks both ways.
 * Files: the desk's files are put in its folder for that driver's phone before the row goes (sync plan Step 4), except one that is a load's rate confirmation. The phone's photos are fetched into the desk's own storage when the message is taken, through the same
 * checks a dispatcher's upload passes and inside the plan's storage allowance; a file that cannot be kept is named in the text with the reason.
 * Retention (Chris, 2026-11-21): `purgeDriverMessages` takes a row and its files off the bridge one day after it was read; the desk keeps the record.
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
    select: { id: true, body: true, sentBy: true, load: { select: { loadNumber: true } }, attachments: { select: { id: true, name: true, mime: true, bytes: true, sha256: true, storageKey: true } }, thread: { select: { driver: { select: { id: true, phoneUserId: true } } } } }
  });
  if (!m || m.thread.driver.phoneUserId !== item.phoneUserId) return null;
  // The files first: a message never names one the phone cannot open. The bytes of a rate confirmation never go, whatever they were attached as; nor does one no longer on the desk.
  const rateCons = new Set(
    m.attachments.length === 0 ? [] : (await prisma.loadDocument.findMany({ where: { workspaceId, kind: "rate_con", sha256: { in: m.attachments.map((a) => a.sha256) } }, select: { sha256: true } })).map((d) => d.sha256)
  );
  const files: SentFile[] = [];
  for (const a of m.attachments) {
    const data = rateCons.has(a.sha256) ? null : await readFile(a.storageKey);
    if (!data) continue;
    const path = deskFilePath(orgId, item.phoneUserId, a.id, a.mime);
    try {
      await transport.uploadDeskFile(path, data, a.mime);
    } catch (e) {
      // No answer: the message waits with its files. Refused: the words go without this one (the phone says a file is with dispatch).
      if ((e as { code?: string }).code === "unreachable") throw e;
      continue;
    }
    files.push({ path, name: a.name ?? fileNameOf(path), mime: a.mime, bytes: a.bytes });
  }
  const row = await transport.insertDriverMessage(
    toDriverRow({ orgId, phoneUserId: item.phoneUserId, deskDriverId: m.thread.driver.id, messageId: m.id, body: m.body, fileCount: m.attachments.length, loadNumber: m.load?.loadNumber ?? null, senderName: m.sentBy, files })
  );
  return { rowId: row.id, messageId: m.id };
}

export type MessagePullResult = { taken: number; ignored: number; readByDriver: number; readOnDesk: number; files: number; waiting: number };

/**
 * Fetch a driver row's photos and keep the ones that pass. Nothing is stored here; the caller stores inside its own transaction's lifetime. `unreachable`: the link did not answer,
 * so the row is left on the bridge and taken on the next run (never taken without its files).
 */
async function fetchFiles(transport: BridgeTransport, orgId: string, workspaceId: string, row: DriverMessageRow): Promise<{ checked: Extract<ReturnType<typeof checkAttachment>, { ok: true }>[]; notKept: Partial<Record<NotKept, number>> } | "unreachable"> {
  const notKept: Partial<Record<NotKept, number>> = {};
  const add = (k: NotKept, n = 1) => (notKept[k] = (notKept[k] ?? 0) + n);
  const list = (Array.isArray(row.attachments) ? row.attachments : []).filter((a) => typeof a?.path === "string");
  const checked: Extract<ReturnType<typeof checkAttachment>, { ok: true }>[] = [];
  for (const [i, a] of list.entries()) {
    // Over the desk's own per-message limit, or a path outside this driver's folder: refused, never fetched.
    if (i >= ATTACHMENTS_PER_MESSAGE || !attachmentPathAllowed(orgId, row.driver_sub, a.path)) {
      add("refused");
      continue;
    }
    let data: Uint8Array | null;
    try {
      data = await transport.downloadDriverFile(a.path);
    } catch (e) {
      if ((e as { code?: string }).code === "unreachable") return "unreachable";
      add("refused");
      continue;
    }
    if (!data) {
      add("gone");
      continue;
    }
    const c = checkAttachment(a.name ?? fileNameOf(a.path), a.mime ?? null, data);
    if (!c.ok) add("refused");
    else checked.push(c);
  }
  if (checked.length > 0 && (await storageRefusal(checked.reduce((s, f) => s + f.data.length, 0), workspaceId))) {
    add("full", checked.length);
    return { checked: [], notKept };
  }
  return { checked, notKept };
}

/** Read marks look this far back (a dispatcher opening a thread weeks later still tells the phone). */
const READ_WINDOW_DAYS = 30;

/**
 * Take the phone's messages into the desk, at least once and idempotent. A row from a phone no driver on this desk holds is left on the bridge (counted as ignored), never guessed at.
 * Then the read marks: the driver's reads of desk messages land on the desk's out messages (`readAt`), and the dispatcher's reads of the driver's messages go to the bridge (`read_at`).
 */
export async function pullDriverMessages(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<MessagePullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const res: MessagePullResult = { taken: 0, ignored: 0, readByDriver: 0, readOnDesk: 0, files: 0, waiting: 0 };
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
    const thread = await prisma.thread.upsert({ where: { driverId: driver.id }, update: {}, create: { workspaceId, driverId: driver.id } });
    const again = await prisma.message.findUnique({ where: { threadId_clientId: { threadId: thread.id, clientId: row.id } }, select: { id: true } });
    if (!again) {
      const got = await fetchFiles(transport, orgId, workspaceId, row);
      if (got === "unreachable") {
        res.waiting += 1;
        continue;
      }
      // Bytes first, then the rows; if the rows fail the bytes go again, so nothing is left that no message points at (as sendMessage does).
      const stored: Awaited<ReturnType<typeof storeFile>>[] = [];
      try {
        for (const f of got.checked) stored.push(await storeFile(workspaceId, f));
        const made = await prisma.$transaction(async (tx) => {
          const twice = await tx.message.findUnique({ where: { threadId_clientId: { threadId: thread.id, clientId: row.id } }, select: { id: true } });
          if (twice) return false;
          await tx.message.create({
            data: {
              threadId: thread.id,
              direction: "in",
              body: deskBodyOf(row, got.notKept),
              clientId: row.id,
              sentAt,
              deliveredAt: now,
              attachments: { create: stored.map((s) => ({ id: s.id, kind: s.kind, name: s.name, mime: s.mime, bytes: s.bytes, sha256: s.sha256, storageKey: s.storageKey })) }
            }
          });
          const t = await tx.thread.findUniqueOrThrow({ where: { id: thread.id }, select: { lastMessageAt: true } });
          await tx.thread.update({ where: { id: thread.id }, data: { lastMessageAt: sentAt > t.lastMessageAt ? sentAt : t.lastMessageAt } });
          return true;
        });
        if (!made) await removeFiles(stored.map((s) => s.storageKey));
        else res.files += stored.length;
      } catch (e) {
        await removeFiles(stored.map((s) => s.storageKey));
        throw e;
      }
    }
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

/**
 * Retention (Chris, 2026-11-21): take this fleet's rows off the bridge one day after they were read, files first, then the rows (a row whose files could not be removed stays and
 * is tried again on the next run, so no file is left that no row names). Only delivered and read rows are ever taken: a message nobody has read, or that the desk has not taken,
 * stays. The desk's own copy is the record and is never touched here. Runs from the bridge cron right after the pull, so the last read marks are already on the desk.
 */
export async function purgeDriverMessages(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<{ removed: number; files: number }> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return { removed: 0, files: 0 };
  const orgId = ws.bridgeOrgId;
  const readBefore = new Date(now.getTime() - BRIDGE_KEEP_MS);
  const due = await transport.driverMessagesReadBefore(orgId, readBefore, opts.limit ?? 200);
  if (due.length === 0) return { removed: 0, files: 0 };
  const paths = due.flatMap((r) => (Array.isArray(r.attachments) ? r.attachments : []).map((a) => a?.path).filter((p): p is string => typeof p === "string"));
  if (paths.length > 0) await transport.removeDriverFiles(paths);
  await transport.deleteDriverMessages(orgId, due.map((r) => r.id), readBefore);
  return { removed: due.length, files: paths.length };
}
