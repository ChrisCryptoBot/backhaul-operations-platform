import { prisma } from "@/lib/db";
import { notQuote } from "@/lib/quote-status";
import { inTerminal } from "./queries";
import { currentWorkspaceId } from "./workspace";

/** Loads taken off the desk are hidden, not erased. This lists them (newest deletion first) so one can be put back after the twenty seconds the toast allowed. */
export const DELETED_PAGE = 100;

export type DeletedRow = { id: string; loadNumber: string | null; brokerName: string | null; origin: string | null; destination: string | null; status: string; deletedAt: Date; reason: string | null; note: string | null };

export async function countDeletedLoads(workspaceId = currentWorkspaceId(), terminal: string | null = null): Promise<number> {
  return prisma.load.count({ where: { workspaceId, deletedAt: { not: null }, ...notQuote, ...inTerminal(terminal) } });
}

export async function listDeletedLoads(workspaceId = currentWorkspaceId(), terminal: string | null = null): Promise<DeletedRow[]> {
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: { not: null }, ...notQuote, ...inTerminal(terminal) },
    select: { id: true, loadNumber: true, brokerName: true, originAddress: true, destinationAddress: true, status: true, deletedAt: true },
    orderBy: { deletedAt: "desc" },
    take: DELETED_PAGE
  });
  // The reason a load was deleted is on its audit event; a load deleted twice (restored and deleted again) shows the latest.
  const events = loads.length
    ? await prisma.auditEvent.findMany({ where: { workspaceId, action: "deleted", loadId: { in: loads.map((l) => l.id) } }, orderBy: { createdAt: "desc" }, select: { loadId: true, summary: true, reason: true } })
    : [];
  const latest = new Map<string, { summary: string; reason: string | null }>();
  for (const e of events) if (e.loadId && !latest.has(e.loadId)) latest.set(e.loadId, { summary: e.summary, reason: e.reason });
  return loads.map((l) => ({
    id: l.id,
    loadNumber: l.loadNumber,
    brokerName: l.brokerName,
    origin: l.originAddress,
    destination: l.destinationAddress,
    status: l.status,
    deletedAt: l.deletedAt!,
    reason: latest.get(l.id)?.summary.replace(/^Deleted: /, "") ?? null,
    note: latest.get(l.id)?.reason ?? null
  }));
}
