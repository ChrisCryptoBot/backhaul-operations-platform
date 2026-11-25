import { loadStatusFor } from "@/lib/load-state";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { describePay } from "@/lib/audit-diff";
import { dateTime, LOAD_STATUS } from "@/lib/desk-format";
import { CAN_CANCEL, CAN_RESCHEDULE, CAN_TONU, isCancelReason, isRescheduleReason, reasonLabel, shiftStops } from "@/lib/disruptions";
import { loadWindow } from "@/lib/schedule";
import { DispatchError, findDriverClash } from "./dispatch";
import { recordAudit } from "./audit";
import { recordAssignmentEvent } from "./assignment-events";
import { claimAssignment, claimLoad, dropAssignment, LoadMoved } from "./claim";
import { num } from "./convert";
import { lockWorkspace } from "./plan";
import { findTwinLoad, duplicateMessage } from "./twins";
import type { Terminals } from "@/lib/scope";
import { enqueueForLoad } from "@/server/bridge/outbox";
import { allowedFor } from "./scope";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { senderNameOf } from "@/lib/driver-messages";
import { currentActor } from "./identity";

/**
 * When a load falls through or moves. Cancelling and a TONU keep the reason the dispatcher picked (so it can be counted), and
 * rescheduling moves every stop by the same amount. Each runs in one transaction with its audit event.
 */
type Why = { reason: string; note?: string | null };

function checkWhy(w: Why, valid: (k: string) => boolean): string {
  if (!valid(w.reason)) throw new DispatchError("bad_reason", "Pick a reason from the list.");
  if (w.reason === "other" && (w.note ?? "").trim().length < 3) throw new DispatchError("bad_reason", "Say what happened when the reason is Other.");
  return reasonLabel(w.reason);
}

/** A move that lost its race says so as a refusal, in the words the other refusals use. */
async function movedBy<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof LoadMoved) throw new DispatchError("not_allowed", e.message);
    throw e;
  }
}

/** The most a TONU fee can be: well past any real one, and well inside what the column holds. */
export const MAX_TONU_FEE = 100_000;

const statusLabel = (s: string) => LOAD_STATUS[s]?.label ?? s;

async function loadWithDriver(loadId: string, workspaceId: string, allowed: Terminals) {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, ...inTerminal(allowed) }, include: { assignment: { include: { driver: true } }, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  return load;
}

/** Cancel a load that has not finished. Any driver on it is taken off; the reason is kept on the load and in the audit log. */
export async function cancelLoad(input: Why & { loadId: string }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await loadWithDriver(input.loadId, workspaceId, scope);
  if (!CAN_CANCEL.includes(load.status)) throw new DispatchError("not_allowed", `A ${statusLabel(load.status).toLowerCase()} load cannot be cancelled.`);
  const label = checkWhy(input, isCancelReason);
  const a = load.assignment;
  await movedBy(() => prisma.$transaction(async (tx) => {
    await claimLoad(tx, load.id, workspaceId, CAN_CANCEL, { status: "cancelled", cancelledAt: now, cancelReason: input.reason, cancelNote: input.note?.trim() || null }, inTerminal(scope) as Prisma.LoadWhereInput);
    if (a) await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: "cancel", now });
    if (a) await dropAssignment(tx, load.id);
    await tx.loadLeg.updateMany({ where: { loadId: load.id, status: "active" }, data: { status: "closed", endedAt: now } });
    await tx.handoff.updateMany({ where: { loadId: load.id, state: { in: ["dropped", "disputed"] } }, data: { state: "cancelled" } });
    await recordAssignmentEvent(tx, {
      workspaceId,
      loadId: load.id,
      loadNumber: load.loadNumber,
      kind: "cancelled",
      driverId: a?.driverId ?? null,
      driverName: a?.driver.name ?? null,
      reasonNote: input.note?.trim() ? `${label}: ${input.note.trim()}` : label,
      assignmentVersion: a?.assignmentVersion ?? null,
      at: now
    });
    await recordAudit(
      {
        entity: "load",
        action: "cancelled",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Cancelled: ${label}${a ? `, ${a.driver.name} taken off` : ""}`,
        reason: input.note,
        before: { Status: statusLabel(load.status), Driver: a?.driver.name ?? null },
        after: { Status: "Cancelled", Reason: label, Driver: null },
        at: now, workspaceId
      },
      tx
    );
  }));
}

/** The driver reached the pickup and there was nothing to haul: record the truck-ordered-not-used fee and close the load. */
export async function recordTonu(input: Why & { loadId: string; fee: number }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await loadWithDriver(input.loadId, workspaceId, scope);
  if (!CAN_TONU.includes(load.status)) throw new DispatchError("not_allowed", "A TONU is for a load whose driver has accepted it or is on the way.");
  // A TONU is a load that was never hauled. Once the driver has reached a delivery stop the load was hauled: deliver it, with whatever was short on the invoice.
  if (load.stops.slice(1).some((s) => s.arrivedAt != null)) throw new DispatchError("not_allowed", "The driver has already reached a delivery stop, so this load was hauled. Enter the delivery instead, and bill what was agreed.");
  if (!Number.isFinite(input.fee) || input.fee <= 0) throw new DispatchError("bad_fee", "Type the TONU fee the customer owes, above zero.");
  if (input.fee > MAX_TONU_FEE) throw new DispatchError("bad_fee", `A TONU fee above $${MAX_TONU_FEE.toLocaleString("en-US")} is not a fee. Check the amount.`);
  const label = checkWhy(input, isCancelReason);
  const a = load.assignment;
  const fee = input.fee.toFixed(2);
  await movedBy(() => prisma.$transaction(async (tx) => {
    await claimLoad(tx, load.id, workspaceId, CAN_TONU, { status: "tonu", tonuRevenue: input.fee, cancelledAt: now, cancelReason: input.reason, cancelNote: input.note?.trim() || null }, inTerminal(scope) as Prisma.LoadWhereInput);
    if (a) await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: "cancel", now });
    if (a) await tx.assignment.updateMany({ where: { loadId: load.id }, data: { status: "completed", respondedAt: a.respondedAt ?? now } });
    await tx.loadLeg.updateMany({ where: { loadId: load.id, status: "active" }, data: { status: "closed", endedAt: now } });
    await tx.handoff.updateMany({ where: { loadId: load.id, state: { in: ["dropped", "disputed"] } }, data: { state: "cancelled" } });
    await recordAssignmentEvent(tx, {
      workspaceId,
      loadId: load.id,
      loadNumber: load.loadNumber,
      kind: "tonu",
      driverId: a?.driverId ?? null,
      driverName: a?.driver.name ?? null,
      reasonNote: input.note?.trim() ? `${label}: ${input.note.trim()}` : label,
      assignmentVersion: a?.assignmentVersion ?? null,
      at: now
    });
    await recordAudit(
      {
        entity: "load",
        action: "tonu",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `TONU, $${fee}: ${label}`,
        reason: input.note,
        before: { Status: statusLabel(load.status), Fee: null },
        after: { Status: "TONU", Reason: label, Fee: `$${fee}` },
        at: now, workspaceId
      },
      tx
    );
  }));
}

/**
 * Move the pickup (or only `stopIds` when chosen) to a new time. Every selected stop moves by the same amount so gaps stay as they were.
 * An `in_progress` load can move chosen unvisited stops; whole-load reschedule stays pre-start only. A driver who would then be on another
 * load at the same time blocks it. A driver who already had the load is asked to confirm again.
 */
export async function rescheduleLoad(input: Why & { loadId: string; newPickup: Date; stopIds?: string[] }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await loadWithDriver(input.loadId, workspaceId, scope);
  const selectedIds = Array.isArray(input.stopIds) && input.stopIds.length > 0 ? [...new Set(input.stopIds)] : null;
  const eligible = selectedIds ? ["draft", "accepted", "in_progress"] : CAN_RESCHEDULE;
  if (!eligible.includes(load.status)) {
    throw new DispatchError("not_allowed", selectedIds ? "A finished, cancelled, or TONU load cannot be rescheduled." : "Only a load that has not started can be rescheduled.");
  }
  const label = checkWhy(input, isRescheduleReason);
  if (selectedIds) {
    const byId = new Map(load.stops.map((s) => [s.id, s]));
    for (const sid of selectedIds) {
      const st = byId.get(sid);
      if (!st) throw new DispatchError("not_allowed", "One of those stops is no longer on the load.");
      if (st.arrivedAt != null) throw new DispatchError("not_allowed", "Visited stops cannot be rescheduled.");
    }
  }
  const chosenSet = selectedIds ? new Set(selectedIds) : null;
  const anchorStop = load.stops.find((s) => (!chosenSet || chosenSet.has(s.id)) && (s.timeWindowEarliest ?? s.timeWindowLatest));
  const from = anchorStop?.timeWindowEarliest ?? anchorStop?.timeWindowLatest ?? null;
  if (!anchorStop || !from) throw new DispatchError("bad_time", selectedIds ? "The selected stops have no time window to move." : "This load has no pickup window to move.");
  if (!Number.isFinite(input.newPickup.getTime())) throw new DispatchError("bad_time", "Pick a date and time for the pickup.");
  const delta = input.newPickup.getTime() - from.getTime();
  if (delta === 0) throw new DispatchError("bad_time", "That is the time the pickup already has.");

  const oldWindow = loadWindow(load.stops)!;
  const shifted = shiftStops(load.stops, delta, chosenSet ?? undefined);
  let prevEarliest: number | null = null;
  for (const s of shifted) {
    if (!s.timeWindowEarliest) continue;
    const ms = s.timeWindowEarliest.getTime();
    if (prevEarliest != null && ms < prevEarliest) {
      throw new DispatchError("bad_time", "Moving those stops puts a stop earlier than the stop ahead of it. Select the later stops too, or pick another time.");
    }
    prevEarliest = ms;
  }
  const newWindow = loadWindow(shifted)!;
  const a = load.assignment && load.assignment.status !== "declined" ? load.assignment : null;
  const reconfirm = a != null && (a.status === "dispatched" || a.status === "accepted");
  const touchedFirst = !chosenSet || (load.stops[0] ? chosenSet.has(load.stops[0].id) : false);

  await movedBy(() => prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    if (a) {
      const clash = await findDriverClash(a.driverId, load.id, newWindow, tx);
      if (clash) throw new DispatchError("double_booked", `${a.driver.name} would be on ${clash.loadNumber ?? "another load"} at the new time. Pick another time, or take the driver off this load first.`);
    }
    // From the state it was read in: a load that started, was cancelled or was moved since is not moved again.
    await claimLoad(tx, load.id, workspaceId, eligible, {
      ...(touchedFirst && load.scheduledDate ? { scheduledDate: new Date(load.scheduledDate.getTime() + delta) } : {}),
      ...(reconfirm && load.status !== loadStatusFor("dispatched") ? { status: loadStatusFor("dispatched") } : {})
    }, inTerminal(scope) as Prisma.LoadWhereInput);
    for (const s of shifted) {
      if (chosenSet && !chosenSet.has(s.id)) continue;
      await tx.stop.update({ where: { id: s.id }, data: { timeWindowEarliest: s.timeWindowEarliest, timeWindowLatest: s.timeWindowLatest } });
    }
    if (reconfirm) {
      // The driver has to say yes again, so the load is no longer accepted (src/lib/load-state.ts: a sent assignment goes with a draft load).
      await claimAssignment(tx, load.id, ["dispatched", "accepted"], { status: "dispatched", dispatchedAt: now, dispatchedBy: senderNameOf(currentActor()), respondedAt: null, driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 } });
      await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: "dispatch", now });
      await recordAssignmentEvent(tx, {
        workspaceId,
        loadId: load.id,
        loadNumber: load.loadNumber,
        kind: "reoffered",
        driverId: a!.driverId,
        driverName: a!.driver.name,
        reasonNote: input.note?.trim() ? `${label}: ${input.note.trim()}` : label,
        assignmentVersion: a!.assignmentVersion + 1,
        at: now
      });
    } else if (load.status === "in_progress") {
      await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: "update", now });
    }
    await recordAudit(
      {
        entity: "load",
        action: "rescheduled",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `${chosenSet ? `${chosenSet.size} ${chosenSet.size === 1 ? "stop" : "stops"} moved` : "Pickup moved"} from ${dateTime(oldWindow.start)} to ${dateTime(newWindow.start)}: ${label}${reconfirm ? `. ${a!.driver.name} has to confirm again` : ""}`,
        reason: input.note,
        before: { Pickup: dateTime(oldWindow.start), "Last stop by": dateTime(oldWindow.end), Driver: a ? `${a.driver.name} (${describePay(a.payKind, num(a.payRate))})` : null },
        after: { Pickup: dateTime(newWindow.start), "Last stop by": dateTime(newWindow.end), Driver: a ? `${a.driver.name}${reconfirm ? ", confirm again" : ""}` : null },
        at: now, workspaceId
      },
      tx
    );
  }));
}

/**
 * Reopen a cancelled load or a TONU that was recorded by mistake (the customer called back, the wrong load was cancelled). It goes back to the board as a draft with no driver, the
 * cancellation or TONU is cleared, and the reason is kept. Not once a TONU has been invoiced (take the invoice back first), and not if another load now carries the same number.
 */
export async function reopenCancelled(input: { loadId: string; reason: string }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const why = input.reason.trim();
  if (why.length < 3) throw new DispatchError("bad_reason", "Say why the load is being reopened.");
  await movedBy(() =>
    prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const load = await tx.load.findFirst({ where: { id: input.loadId, workspaceId, ...inTerminal(scope) }, include: { assignment: { include: { driver: true } } } });
      if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
      if (load.status !== "cancelled" && load.status !== "tonu") throw new DispatchError("not_allowed", "Only a cancelled load, or a TONU, can be reopened.");
      if (load.paymentStatus) throw new DispatchError("not_allowed", "The TONU has been invoiced. Take the invoice back first.");
      const twin = await findTwinLoad(workspaceId, load.loadNumber, load.brokerName, load.id, tx);
      if (twin) throw new DispatchError("not_allowed", `${duplicateMessage(twin)} Delete or change that one first.`);
      const was = load.status;
      await claimLoad(tx, load.id, workspaceId, [was], { status: loadStatusFor("draft"), cancelledAt: null, cancelReason: null, cancelNote: null, tonuRevenue: null, tonuMiles: null, dockWaitMinutes: null }, { paymentStatus: null, ...inTerminal(scope) });
      await tx.stop.updateMany({ where: { loadId: load.id }, data: { arrivedAt: null, waitMinutes: null, sealNumber: null, arrivedSource: null } });
      if (load.assignment) await dropAssignment(tx, load.id);
      await recordAssignmentEvent(tx, {
        workspaceId,
        loadId: load.id,
        loadNumber: load.loadNumber,
        kind: "reopened",
        driverId: load.assignment?.driverId ?? null,
        driverName: load.assignment?.driver.name ?? null,
        reasonNote: why,
        assignmentVersion: load.assignment?.assignmentVersion ?? null,
        at: now
      });
      await recordAudit(
        {
          entity: "load",
          action: "load_reopened",
          loadId: load.id,
          loadNumber: load.loadNumber,
          summary: `${was === "tonu" ? "TONU" : "Cancellation"} taken back: back on the board for a driver`,
          reason: why,
          before: { Status: statusLabel(was), Reason: reasonLabel(load.cancelReason), ...(was === "tonu" ? { Fee: `$${num(load.tonuRevenue).toFixed(2)}` } : {}) },
          after: { Status: "Needs a driver", Reason: null },
          at: now, workspaceId
        },
        tx
      );
    })
  );
}
