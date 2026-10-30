import { prisma } from "@/lib/db";
import { sizeLabel } from "@/lib/attachments";
import { effectivePlan, storageLimit } from "@/lib/plans";
import { workspacePlan } from "./plan";
import { currentWorkspaceId } from "./workspace";

/**
 * What a desk keeps in pictures and files, and whether one more would pass its plan's allowance: the files on messages and the documents on loads count together.
 */
export async function storageUsed(workspaceId = currentWorkspaceId()): Promise<number> {
  const [messages, documents] = await Promise.all([
    prisma.messageAttachment.aggregate({ _sum: { bytes: true }, where: { message: { thread: { workspaceId } } } }),
    prisma.loadDocument.aggregate({ _sum: { bytes: true }, where: { workspaceId } })
  ]);
  return (messages._sum.bytes ?? 0) + (documents._sum.bytes ?? 0);
}

/** The refusal to show when adding `adding` bytes would pass the plan's allowance, or null when it fits (or the plan has no allowance). */
export async function storageRefusal(adding: number, workspaceId = currentWorkspaceId()): Promise<string | null> {
  if (adding <= 0) return null;
  const cap = storageLimit(effectivePlan(await workspacePlan(workspaceId)));
  if (cap == null) return null;
  const used = await storageUsed(workspaceId);
  return used + adding > cap ? `This desk's plan holds ${sizeLabel(cap)} of pictures and files, and ${sizeLabel(used)} is used. Remove old attachments or documents, or talk to a person about a larger plan.` : null;
}
