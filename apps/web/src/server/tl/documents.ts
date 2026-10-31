import { prisma } from "@/lib/db";
import { DOC_KINDS, DOC_LABEL, isDocKind, type DocKind } from "@/lib/documents";
import { recordAudit } from "./audit";
import { removeFiles, storeFile } from "./message-files";
import type { CheckedFile } from "./messages";
import { storageRefusal } from "./storage";
import { currentWorkspaceId } from "./workspace";

/**
 * Documents kept on a load: the rate confirmation it was booked from, the proof of delivery, a receipt, anything else. A file is checked like a message attachment (its real type
 * and size, pictures stripped of their location) before it is kept, stored in the desk's private storage, and named by a row here. Factoring reads these rows: a document that is
 * not here is not in the packet. Every add and remove is one transaction with its audit event.
 */
export { DOC_KINDS, DOC_LABEL, isDocKind, type DocKind };
export const DOCS_PER_LOAD = 20;

export type DocResult = { ok: true; id: string } | { ok: false; error: string };
/** `stopId` is the delivery stop a proof of delivery belongs to; blank is the whole load. */
export type DocRow = { id: string; kind: DocKind; name: string; mime: string; bytes: number; createdAt: Date; addedBy: string; stopId: string | null };

export async function addLoadDocument(loadId: string, kind: string, file: CheckedFile, now = new Date(), workspaceId = currentWorkspaceId(), addedBy = "Dispatcher", stopId: string | null = null): Promise<DocResult> {
  if (!isDocKind(kind)) return { ok: false, error: "Say what kind of document it is." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, status: { not: "quote" } }, select: { id: true, loadNumber: true, factoringStatus: true, stops: { select: { id: true, stopType: true, stopRole: true } } } });
  if (!load) return { ok: false, error: "That load does not exist." };
  // What went to the factor must stay as it was sent: nothing is added to it either.
  if (load.factoringStatus !== "none" && load.factoringStatus !== "rejected") return { ok: false, error: "This load's invoice has gone to a factoring company, so its documents stay as they were sent." };
  // A proof of delivery can belong to one delivery stop; nothing else is tied to a stop.
  if (stopId) {
    const stop = load.stops.find((s) => s.id === stopId);
    if (kind !== "pod" || !stop || (stop.stopRole ?? stop.stopType) !== "delivery") return { ok: false, error: "A stop can only be named on a proof of delivery, and it has to be one of this load's delivery stops." };
  }
  const full = { ok: false as const, error: `A load can carry up to ${DOCS_PER_LOAD} documents.` };
  if ((await prisma.loadDocument.count({ where: { loadId, workspaceId } })) >= DOCS_PER_LOAD) return full;
  const refused = await storageRefusal(file.data.length, workspaceId);
  if (refused) return { ok: false, error: refused };
  const stored = await storeFile(workspaceId, file);
  try {
    const doc = await prisma.$transaction(async (tx) => {
      // Counted again under a lock on the load: several files added at the same moment each saw room above, and only this makes the limit hold.
      await tx.$queryRaw`select id from loads where id = ${loadId} for update`;
      if ((await tx.loadDocument.count({ where: { loadId, workspaceId } })) >= DOCS_PER_LOAD) return null;
      const d = await tx.loadDocument.create({ data: { id: stored.id, workspaceId, loadId, kind, name: stored.name, mime: stored.mime, bytes: stored.bytes, sha256: stored.sha256, storageKey: stored.storageKey, addedBy, stopId: stopId || null } });
      await recordAudit({ entity: "load", action: "document_added", loadId, loadNumber: load.loadNumber, summary: `${DOC_LABEL[kind]} added: ${stored.name}`, before: null, after: { Document: stored.name, Kind: DOC_LABEL[kind] }, at: now, workspaceId }, tx);
      return d;
    });
    if (!doc) {
      await removeFiles([stored.storageKey]);
      return full;
    }
    return { ok: true, id: doc.id };
  } catch (e) {
    await removeFiles([stored.storageKey]);
    throw e;
  }
}

export async function listLoadDocuments(loadId: string, workspaceId = currentWorkspaceId()): Promise<DocRow[]> {
  const rows = await prisma.loadDocument.findMany({ where: { loadId, workspaceId }, orderBy: { createdAt: "asc" } });
  return rows.map((d) => ({ id: d.id, kind: d.kind as DocKind, name: d.name, mime: d.mime, bytes: d.bytes, createdAt: d.createdAt, addedBy: d.addedBy, stopId: d.stopId }));
}

export async function removeLoadDocument(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DocResult> {
  const d = await prisma.loadDocument.findFirst({ where: { id, workspaceId }, include: { load: { select: { loadNumber: true, factoringStatus: true } } } });
  if (!d) return { ok: false, error: "That document does not exist." };
  // What went to the factor must stay as it was sent.
  if (d.load.factoringStatus !== "none" && d.load.factoringStatus !== "rejected") return { ok: false, error: "This load's invoice has gone to a factoring company, so its documents stay as they were sent." };
  await prisma.$transaction(async (tx) => {
    await tx.loadDocument.delete({ where: { id } });
    await recordAudit({ entity: "load", action: "document_removed", loadId: d.loadId, loadNumber: d.load.loadNumber, summary: `${DOC_LABEL[d.kind as DocKind] ?? d.kind} removed: ${d.name}`, before: { Document: d.name }, after: null, at: now, workspaceId }, tx);
  });
  await removeFiles([d.storageKey]);
  return { ok: true, id };
}

/**
 * How many of a delivered load's delivery stops have no proof of delivery on file, for each load given. A proof with no stop named covers the whole load. Null for a load with no delivery
 * stop to ask about. Used by the alert and the invoice caution.
 */
export async function podStopsMissing(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (loadIds.length === 0) return out;
  const [docs, stops] = await Promise.all([
    prisma.loadDocument.findMany({ where: { workspaceId, loadId: { in: loadIds }, kind: "pod" }, select: { loadId: true, stopId: true } }),
    prisma.stop.findMany({ where: { loadId: { in: loadIds } }, select: { id: true, loadId: true, stopType: true, stopRole: true } })
  ]);
  for (const id of loadIds) {
    const mine = docs.filter((d) => d.loadId === id);
    const deliveries = stops.filter((s) => s.loadId === id && (s.stopRole ?? s.stopType) === "delivery");
    if (deliveries.length === 0) continue;
    if (mine.some((d) => d.stopId == null)) {
      out.set(id, 0);
      continue;
    }
    const covered = new Set(mine.map((d) => d.stopId));
    out.set(id, deliveries.filter((s) => !covered.has(s.id)).length);
  }
  return out;
}

/** Which kinds of document a load has (for the factoring packet). */
export async function documentKinds(loadId: string, workspaceId = currentWorkspaceId()): Promise<Set<DocKind>> {
  const rows = await prisma.loadDocument.findMany({ where: { loadId, workspaceId }, select: { kind: true }, distinct: ["kind"] });
  return new Set(rows.map((r) => r.kind as DocKind));
}
