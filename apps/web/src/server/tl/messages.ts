import { prisma } from "@/lib/db";
import { cleanBody } from "@/lib/messages";
import { ATTACHMENTS_PER_MESSAGE, summaryOf, type Checked } from "@/lib/attachments";
import { removeFiles, storeFile } from "./message-files";
import { currentWorkspaceId } from "./workspace";

/**
 * The desk's messages: one thread per driver. Everything here is the desk's own record. Nothing carries a message to a driver's phone yet
 * (`deliveredAt` stays empty), and nothing here pretends it does.
 */
export type ThreadSummary = { driverId: string; driverName: string; truck: string | null; lastBody: string; lastDirection: string; lastAt: Date; unread: number };

export async function listThreads(workspaceId = currentWorkspaceId()): Promise<ThreadSummary[]> {
  const [threads, unread] = await Promise.all([
    prisma.thread.findMany({
      where: { workspaceId },
      orderBy: { lastMessageAt: "desc" },
      include: { driver: { select: { name: true, assignedVehicle: { select: { name: true } } } }, messages: { orderBy: { sentAt: "desc" }, take: 1, include: { attachments: { select: { kind: true, name: true, mime: true } } } } }
    }),
    prisma.message.groupBy({ by: ["threadId"], where: { direction: "in", readAt: null, thread: { workspaceId } }, _count: { _all: true } })
  ]);
  const unreadBy = new Map(unread.map((u) => [u.threadId, u._count._all]));
  return threads.map((t) => ({
    driverId: t.driverId,
    driverName: t.driver.name,
    truck: t.driver.assignedVehicle?.name ?? null,
    lastBody: t.messages[0]?.body || (t.messages[0] ? summaryOf(t.messages[0].attachments) : ""),
    lastDirection: t.messages[0]?.direction ?? "out",
    lastAt: t.messages[0]?.sentAt ?? t.lastMessageAt,
    unread: unreadBy.get(t.id) ?? 0
  }));
}

/** The number on the sidebar: messages from drivers the dispatcher has not opened. */
export async function unreadMessageCount(workspaceId = currentWorkspaceId()): Promise<number> {
  return prisma.message.count({ where: { direction: "in", readAt: null, thread: { workspaceId } } });
}

export type AttachmentView = { id: string; kind: string; name: string | null; mime: string; bytes: number };
export type ConversationMessage = { id: string; direction: string; body: string; sentAt: Date; deliveredAt: Date | null; load: { id: string; loadNumber: string | null } | null; attachments: AttachmentView[] };
export type Conversation = {
  driver: { id: string; name: string; phone: string | null; terminal: string | null; truck: string | null };
  messages: ConversationMessage[];
  /** The loads this driver has that are still open: what a message can be about. */
  loads: Array<{ id: string; loadNumber: string | null; customer: string | null }>;
};

export async function getConversation(driverId: string, workspaceId = currentWorkspaceId()): Promise<Conversation | null> {
  const driver = await prisma.driver.findFirst({
    where: { id: driverId, workspaceId },
    select: { id: true, name: true, phone: true, terminal: true, assignedVehicle: { select: { name: true } } }
  });
  if (!driver) return null;
  const [thread, assignments] = await Promise.all([
    prisma.thread.findUnique({
      where: { driverId },
      include: { messages: { orderBy: { sentAt: "asc" }, include: { load: { select: { id: true, loadNumber: true } }, attachments: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, name: true, mime: true, bytes: true } } } } }
    }),
    prisma.assignment.findMany({
      where: { driverId, load: { workspaceId, deletedAt: null, status: { in: ["draft", "accepted", "in_progress"] } } },
      select: { load: { select: { id: true, loadNumber: true, brokerName: true } } }
    })
  ]);
  return {
    driver: { id: driver.id, name: driver.name, phone: driver.phone, terminal: driver.terminal, truck: driver.assignedVehicle?.name ?? null },
    messages: (thread?.messages ?? []).map((m) => ({ id: m.id, direction: m.direction, body: m.body, sentAt: m.sentAt, deliveredAt: m.deliveredAt, load: m.load, attachments: m.attachments })),
    loads: assignments.map((a) => ({ id: a.load.id, loadNumber: a.load.loadNumber, customer: a.load.brokerName }))
  };
}

/** Active drivers who have no thread yet: who a conversation can be started with. */
export async function startableDrivers(workspaceId = currentWorkspaceId()) {
  return prisma.driver.findMany({ where: { workspaceId, active: true, thread: null }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 });
}

/** A file that has already passed `checkAttachment` (its bytes are the cleaned ones). */
export type CheckedFile = Extract<Checked, { ok: true }>;
export type SendInput = { driverId: string; body: string; loadId?: string | null; clientId?: string | null; files?: CheckedFile[] };
export type SendResult = { ok: true; id: string; repeat: boolean } | { ok: false; error: string };

/**
 * Save a message the dispatcher wrote. A repeat of the same `clientId` (a double click, a retry) is answered with the message already saved, not a second one.
 * The driver must belong to this workspace; a load, if named, must too.
 */
export async function sendMessage(input: SendInput, workspaceId = currentWorkspaceId()): Promise<SendResult> {
  const files = input.files ?? [];
  if (files.length > ATTACHMENTS_PER_MESSAGE) return { ok: false, error: `A message can carry up to ${ATTACHMENTS_PER_MESSAGE} files.` };
  const clean = cleanBody(input.body, { allowEmpty: files.length > 0 });
  if (!clean.ok) return clean;
  const driver = await prisma.driver.findFirst({ where: { id: input.driverId, workspaceId }, select: { id: true } });
  if (!driver) return { ok: false, error: "That driver is not on this desk." };
  let loadId: string | null = null;
  if (input.loadId) {
    const load = await prisma.load.findFirst({ where: { id: input.loadId, workspaceId, deletedAt: null }, select: { id: true } });
    if (!load) return { ok: false, error: "That load is not on this desk." };
    loadId = load.id;
  }
  const clientId = input.clientId && input.clientId.length <= 64 ? input.clientId : null;

  const thread = await prisma.thread.upsert({ where: { driverId: driver.id }, update: {}, create: { workspaceId, driverId: driver.id } });
  if (clientId) {
    const again = await prisma.message.findUnique({ where: { threadId_clientId: { threadId: thread.id, clientId } }, select: { id: true } });
    if (again) return { ok: true, id: again.id, repeat: true };
  }
  const now = new Date();
  // Keep the bytes first, then the rows; if the rows fail the bytes are removed again, so nothing is left that no message points at.
  const stored = [];
  try {
    for (const f of files) stored.push(await storeFile(workspaceId, f));
    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          threadId: thread.id,
          direction: "out",
          body: clean.body,
          loadId,
          clientId,
          sentAt: now,
          attachments: { create: stored.map((s) => ({ id: s.id, kind: s.kind, name: s.name, mime: s.mime, bytes: s.bytes, sha256: s.sha256, storageKey: s.storageKey })) }
        }
      }),
      prisma.thread.update({ where: { id: thread.id }, data: { lastMessageAt: now } })
    ]);
    return { ok: true, id: message.id, repeat: false };
  } catch (e) {
    await removeFiles(stored.map((s) => s.storageKey));
    throw e;
  }
}

/** The dispatcher opened the conversation: everything the driver wrote in it counts as read. */
export async function markThreadRead(driverId: string, workspaceId = currentWorkspaceId()): Promise<number> {
  const res = await prisma.message.updateMany({ where: { direction: "in", readAt: null, thread: { driverId, workspaceId } }, data: { readAt: new Date() } });
  return res.count;
}
