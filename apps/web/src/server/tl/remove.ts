import { prisma } from "@/lib/db";
import { DELETE_REASONS, isDeleteReason, reasonLabel } from "@/lib/disruptions";
import { LOAD_STATUS } from "@/lib/desk-format";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

/**
 * Take a load that should never have been entered (a duplicate, a slip, a practice load) off the desk, and put it back if that was wrong.
 * It is hidden, not erased: the load, its stops and its audit trail stay, and Undo restores it exactly as it was. A load that is on the road,
 * that has been invoiced, or that is on a driver statement is real money and real miles, so it is refused: cancel it, or void the statement first.
 * Deleting is not cancelling: a cancelled load is counted as one that fell through, a deleted one is not counted at all.
 */
export type RemoveResult = { ok: true } | { ok: false; error: string };

export { DELETE_REASONS };

export async function deleteLoad(input: { loadId: string; reason: string; note?: string | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveResult> {
  const load = await prisma.load.findFirst({ where: { id: input.loadId, workspaceId, deletedAt: null, status: { not: "quote" } }, include: { assignment: { include: { driver: true } }, settlement: true } });
  if (!load) return { ok: false, error: "That load does not exist." };
  if (!isDeleteReason(input.reason)) return { ok: false, error: "Pick a reason from the list." };
  if (input.reason === "other" && (input.note ?? "").trim().length < 3) return { ok: false, error: "Say what happened when the reason is Other." };
  if (load.status === "in_progress") return { ok: false, error: "A load that is on the road cannot be deleted. Cancel it, or record the trip." };
  if (load.paymentStatus) return { ok: false, error: "An invoiced load cannot be deleted: the invoice exists. Take the payment back if it is paid, and keep the load as the record of it." };
  if (load.settlement) return { ok: false, error: "A load on a driver statement cannot be deleted. Void the statement first." };

  const label = reasonLabel(input.reason);
  const a = load.assignment;
  const status = LOAD_STATUS[load.status]?.label ?? load.status;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: load.id }, data: { deletedAt: now } });
    await recordAudit(
      {
        entity: "load",
        action: "deleted",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Deleted: ${label}${a ? `. ${a.driver.name}'s assignment went with it` : ""}`,
        reason: input.note?.trim() || null,
        before: { Load: status, Driver: a?.driver.name ?? null },
        after: { Load: "Deleted", Reason: label },
        at: now, workspaceId
      },
      tx
    );
  });
  return { ok: true };
}

/** Put a deleted load back as it was. */
export async function restoreLoad(loadId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveResult> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: { not: null } } });
  if (!load) return { ok: false, error: "That load is not deleted." };
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: load.id }, data: { deletedAt: null } });
    await recordAudit(
      {
        entity: "load",
        action: "restored",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: "Restored after being deleted",
        before: { Load: "Deleted" },
        after: { Load: LOAD_STATUS[load.status]?.label ?? load.status },
        at: now, workspaceId
      },
      tx
    );
  });
  return { ok: true };
}
