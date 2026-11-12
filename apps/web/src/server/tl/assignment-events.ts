import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentActor } from "./identity";
import { currentWorkspaceId } from "./workspace";
import { isRecallCode, type RecallCode, type RecallDelivery } from "@/lib/recall-reasons";

/**
 * Who held a load, when, and why it changed hands (docs/RELAY_DESIGN.md). Written inside the same transaction as the change and its audit event, so a row exists exactly when the move does.
 * The audit trail says it in words; these rows say it in fields.
 */
type Tx = Prisma.TransactionClient;

export type AssignmentEventKind = "assigned" | "reassigned" | "sent" | "accepted" | "declined" | "recalled" | "removed" | "dropped" | "received";

export async function recordAssignmentEvent(
  tx: Tx,
  i: {
    workspaceId?: string;
    loadId: string;
    loadNumber?: string | null;
    kind: AssignmentEventKind;
    driverId?: string | null;
    driverName?: string | null;
    reasonCode?: RecallCode | null;
    reasonNote?: string | null;
    via?: "dispatcher" | "phone";
    assignmentVersion?: number | null;
    actor?: string;
    at?: Date;
  }
) {
  return tx.assignmentEvent.create({
    data: {
      workspaceId: i.workspaceId ?? currentWorkspaceId(),
      loadId: i.loadId,
      loadNumber: i.loadNumber ?? null,
      kind: i.kind,
      driverId: i.driverId ?? null,
      driverName: i.driverName ?? null,
      reasonCode: i.reasonCode ?? null,
      reasonNote: i.reasonNote?.trim() ? i.reasonNote.trim() : null,
      via: i.via ?? "dispatcher",
      assignmentVersion: i.assignmentVersion ?? null,
      // A driver's own phone is the driver; the desk side is the signed-in person.
      actor: i.actor ?? (i.via === "phone" ? i.driverName ?? "Driver" : currentActor()),
      createdAt: i.at
    }
  });
}

export type HolderEvent = {
  id: string;
  kind: AssignmentEventKind;
  driverName: string | null;
  reasonCode: RecallCode | null;
  reasonNote: string | null;
  actor: string;
  via: "dispatcher" | "phone";
  at: Date;
};

const asKind = (k: string) => k as AssignmentEventKind;

/** A load's holder trail, oldest first. */
export async function holderTrail(loadId: string, workspaceId = currentWorkspaceId()): Promise<HolderEvent[]> {
  const rows = await prisma.assignmentEvent.findMany({ where: { loadId, workspaceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({
    id: r.id,
    kind: asKind(r.kind),
    driverName: r.driverName,
    reasonCode: isRecallCode(r.reasonCode) ? r.reasonCode : null,
    reasonNote: r.reasonNote,
    actor: r.actor,
    via: r.via === "phone" ? "phone" : "dispatcher",
    at: r.createdAt
  }));
}

export type RecalledLoad = { code: RecallCode | null; note: string | null; driverName: string | null; actor: string; at: Date; delivery: RecallDelivery };

/**
 * For each of these loads, the recall that is still the last thing to happen to it, with how it went to the driver link: a load whose newest event is a recall is "recalled, needs a driver";
 * once anyone is assigned again the newest event is something else and it drops out. One query for the events, one for the deliveries.
 */
export async function recalledLoads(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, RecalledLoad>> {
  const out = new Map<string, RecalledLoad>();
  if (loadIds.length === 0) return out;
  const events = await prisma.assignmentEvent.findMany({ where: { workspaceId, loadId: { in: loadIds } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const newest = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!newest.has(e.loadId)) newest.set(e.loadId, e);
  const recalled = [...newest.values()].filter((e) => e.kind === "recalled");
  if (recalled.length === 0) return out;
  // The delivery to the driver link: the cancel queued with the recall (written in the same transaction, so at or just after the event).
  const cancels = await prisma.bridgeOutbox.findMany({ where: { workspaceId, kind: "cancel", loadId: { in: recalled.map((e) => e.loadId) } }, orderBy: { createdAt: "desc" }, select: { loadId: true, status: true, createdAt: true } });
  for (const e of recalled) {
    const c = cancels.find((x) => x.loadId === e.loadId && x.createdAt.getTime() >= e.createdAt.getTime() - 5_000);
    const delivery: RecallDelivery = !c ? "none" : c.status === "done" ? "delivered" : c.status === "failed" ? "failed" : "waiting";
    out.set(e.loadId, { code: isRecallCode(e.reasonCode) ? e.reasonCode : null, note: e.reasonNote, driverName: e.driverName, actor: e.actor, at: e.createdAt, delivery });
  }
  return out;
}
