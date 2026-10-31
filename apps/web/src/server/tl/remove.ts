import { prisma } from "@/lib/db";
import { DELETE_REASONS, isDeleteReason, reasonLabel } from "@/lib/disruptions";
import { LOAD_STATUS } from "@/lib/desk-format";
import { recordAudit } from "./audit";
import { findDriverClash, findTruckClash } from "./dispatch";
import { findTwinLoad, duplicateMessage } from "./twins";
import { loadWindow } from "@/lib/schedule";
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
  const gone = await prisma.$transaction(async (tx) => {
    // Only a load that is still what it was when this was read: not picked up, invoiced or put on a statement in the meantime.
    const out = await tx.load.updateMany({ where: { id: load.id, workspaceId, deletedAt: null, status: { notIn: ["in_progress", "quote"] }, paymentStatus: null, settlement: { is: null } }, data: { deletedAt: now } });
    if (out.count !== 1) return false;
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
    return true;
  });
  if (!gone) return { ok: false, error: "That load changed while you were deleting it (it may have been picked up, invoiced or deleted already). Reload it." };
  return { ok: true };
}

/** Put a deleted load back as it was. */
export async function restoreLoad(loadId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveResult> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: { not: null } }, include: { stops: true, assignment: true } });
  if (!load) return { ok: false, error: "That load is not deleted." };
  // A thrown-away quote is not a load: it is not brought back here.
  if (load.status === "quote") return { ok: false, error: "A quote that was thrown away stays thrown away. Quote it again from Quote a load." };
  // What was true when it was deleted may not be now: the same load number may have been entered again, and the truck or driver may be on another load at that time.
  const twin = await findTwinLoad(workspaceId, load.loadNumber, load.brokerName, load.id);
  if (twin) return { ok: false, error: `${duplicateMessage(twin)} Delete or change that one first.` };
  if (["draft", "accepted", "in_progress"].includes(load.status)) {
    const win = loadWindow(load.stops);
    if (load.vehicleId && win) {
      const busy = await findTruckClash(load.vehicleId, load.id, win, workspaceId);
      if (busy) return { ok: false, error: `Its truck is on ${busy.loadNumber ?? "another load"} at that time now. Move that load first.` };
    }
    if (load.assignment && win) {
      const clash = await findDriverClash(load.assignment.driverId, load.id, win);
      if (clash) return { ok: false, error: `Its driver is on ${clash.loadNumber ?? "another load"} at that time now. Move that load first.` };
    }
  }
  const back = await prisma.$transaction(async (tx) => {
    const out = await tx.load.updateMany({ where: { id: load.id, workspaceId, deletedAt: { not: null } }, data: { deletedAt: null } });
    if (out.count !== 1) return false;
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
    return true;
  });
  if (!back) return { ok: false, error: "That load was already restored." };
  return { ok: true };
}
