import { prisma } from "@/lib/db";
import { sizeLabel } from "@/lib/attachments";
import { effectivePlan, storageLimit } from "@/lib/plans";
import { removeFiles } from "./message-files";
import { workspacePlan } from "./plan";
import { currentWorkspaceId } from "./workspace";

/**
 * What a desk keeps in pictures and files, and whether one more would pass its plan's allowance: the files on messages and the documents on loads count together.
 */
export async function storageUsed(workspaceId = currentWorkspaceId()): Promise<number> {
  const [messages, documents, receipts] = await Promise.all([
    prisma.messageAttachment.aggregate({ _sum: { bytes: true }, where: { message: { thread: { workspaceId } } } }),
    prisma.loadDocument.aggregate({ _sum: { bytes: true }, where: { workspaceId } }),
    prisma.driverReceipt.aggregate({ _sum: { bytes: true }, where: { workspaceId } })
  ]);
  return (messages._sum.bytes ?? 0) + (documents._sum.bytes ?? 0) + (receipts._sum.bytes ?? 0);
}

/** Collect every stored object key belonging to a workspace across load documents, message attachments, and driver receipts. */
export async function collectWorkspaceFileKeys(workspaceId: string): Promise<string[]> {
  const [docs, attachments, receipts] = await Promise.all([
    prisma.loadDocument.findMany({ where: { workspaceId }, select: { storageKey: true } }),
    prisma.messageAttachment.findMany({ where: { message: { thread: { workspaceId } } }, select: { storageKey: true } }),
    prisma.driverReceipt.findMany({ where: { workspaceId, storageKey: { not: null } }, select: { storageKey: true } })
  ]);
  const keys = new Set<string>();
  for (const row of docs) keys.add(row.storageKey);
  for (const row of attachments) keys.add(row.storageKey);
  for (const row of receipts) if (row.storageKey) keys.add(row.storageKey);
  return [...keys];
}

/** Remove every stored object belonging to a workspace before or after permanent deletion of its database rows. */
export async function purgeWorkspaceFiles(workspaceId: string): Promise<number> {
  const keys = await collectWorkspaceFileKeys(workspaceId);
  if (keys.length === 0) return 0;
  await removeFiles(keys);
  return keys.length;
}

/** The refusal to show when adding `adding` bytes would pass the plan's allowance, or null when it fits (or the plan has no allowance). */
export async function storageRefusal(adding: number, workspaceId = currentWorkspaceId()): Promise<string | null> {
  if (adding <= 0) return null;
  const cap = storageLimit(effectivePlan(await workspacePlan(workspaceId)));
  if (cap == null) return null;
  const used = await storageUsed(workspaceId);
  return used + adding > cap ? `This desk's plan holds ${sizeLabel(cap)} of pictures and files, and ${sizeLabel(used)} is used. Remove old attachments or documents, or talk to a person about a larger plan.` : null;
}
