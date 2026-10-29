import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { describePay } from "@/lib/audit-diff";
import { dateTime, LOAD_STATUS } from "@/lib/desk-format";
import { CAN_CANCEL, CAN_RESCHEDULE, CAN_TONU, isCancelReason, isRescheduleReason, reasonLabel, shiftStops } from "@/lib/disruptions";
import { loadWindow } from "@/lib/schedule";
import { DispatchError, findDriverClash } from "./dispatch";
import { recordAudit } from "./audit";
import { num } from "./convert";

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

const statusLabel = (s: string) => LOAD_STATUS[s]?.label ?? s;

async function loadWithDriver(loadId: string) {
  const load = await prisma.load.findUnique({ where: { id: loadId }, include: { assignment: { include: { driver: true } }, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  return load;
}

/** Cancel a load that has not finished. Any driver on it is taken off; the reason is kept on the load and in the audit log. */
export async function cancelLoad(input: Why & { loadId: string }, now = new Date()) {
  const load = await loadWithDriver(input.loadId);
  if (!CAN_CANCEL.includes(load.status)) throw new DispatchError("not_allowed", `A ${statusLabel(load.status).toLowerCase()} load cannot be cancelled.`);
  const label = checkWhy(input, isCancelReason);
  const a = load.assignment;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: load.id }, data: { status: "cancelled", cancelledAt: now, cancelReason: input.reason } });
    if (a) await tx.assignment.delete({ where: { loadId: load.id } });
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
        at: now
      },
      tx
    );
  });
}

/** The driver reached the pickup and there was nothing to haul: record the truck-ordered-not-used fee and close the load. */
export async function recordTonu(input: Why & { loadId: string; fee: number }, now = new Date()) {
  const load = await loadWithDriver(input.loadId);
  if (!CAN_TONU.includes(load.status)) throw new DispatchError("not_allowed", "A TONU is for a load whose driver has accepted it or is on the way.");
  if (!Number.isFinite(input.fee) || input.fee <= 0) throw new DispatchError("bad_fee", "Type the TONU fee the customer owes, above zero.");
  const label = checkWhy(input, isCancelReason);
  const a = load.assignment;
  const fee = input.fee.toFixed(2);
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: load.id }, data: { status: "tonu", tonuRevenue: input.fee, cancelledAt: now, cancelReason: input.reason } });
    if (a) await tx.assignment.update({ where: { loadId: load.id }, data: { status: "completed", respondedAt: a.respondedAt ?? now } });
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
        at: now
      },
      tx
    );
  });
}

/**
 * Move the pickup to a new time; every other stop moves by the same amount. A driver who would then be on another load at the
 * same time blocks it. A driver who already had the load is asked to confirm again.
 */
export async function rescheduleLoad(input: Why & { loadId: string; newPickup: Date }, now = new Date()) {
  const load = await loadWithDriver(input.loadId);
  if (!CAN_RESCHEDULE.includes(load.status)) throw new DispatchError("not_allowed", "Only a load that has not started can be rescheduled.");
  const label = checkWhy(input, isRescheduleReason);
  const first = load.stops.find((s) => s.timeWindowEarliest ?? s.timeWindowLatest);
  const from = first?.timeWindowEarliest ?? first?.timeWindowLatest ?? null;
  if (!first || !from) throw new DispatchError("bad_time", "This load has no pickup window to move.");
  if (!Number.isFinite(input.newPickup.getTime())) throw new DispatchError("bad_time", "Pick a date and time for the pickup.");
  const delta = input.newPickup.getTime() - from.getTime();
  if (delta === 0) throw new DispatchError("bad_time", "That is the time the pickup already has.");

  const oldWindow = loadWindow(load.stops)!;
  const moved = shiftStops(load.stops, delta);
  const newWindow = loadWindow(moved)!;
  const a = load.assignment && load.assignment.status !== "declined" ? load.assignment : null;
  if (a) {
    const clash = await findDriverClash(a.driverId, load.id, newWindow);
    if (clash) throw new DispatchError("double_booked", `${a.driver.name} would be on ${clash.loadNumber ?? "another load"} at the new time. Pick another time, or take the driver off this load first.`);
  }
  const reconfirm = a != null && (a.status === "dispatched" || a.status === "accepted");

  await prisma.$transaction(async (tx) => {
    for (const s of moved) await tx.stop.update({ where: { id: s.id }, data: { timeWindowEarliest: s.timeWindowEarliest, timeWindowLatest: s.timeWindowLatest } });
    if (load.scheduledDate) await tx.load.update({ where: { id: load.id }, data: { scheduledDate: new Date(load.scheduledDate.getTime() + delta) } });
    if (reconfirm) {
      await tx.assignment.update({
        where: { loadId: load.id },
        data: { status: "dispatched", dispatchedAt: now, respondedAt: null, driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 } }
      });
    }
    await recordAudit(
      {
        entity: "load",
        action: "rescheduled",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Pickup moved from ${dateTime(oldWindow.start)} to ${dateTime(newWindow.start)}: ${label}${reconfirm ? `. ${a!.driver.name} has to confirm again` : ""}`,
        reason: input.note,
        before: { Pickup: dateTime(oldWindow.start), "Last stop by": dateTime(oldWindow.end), Driver: a ? `${a.driver.name} (${describePay(a.payKind, num(a.payRate))})` : null },
        after: { Pickup: dateTime(newWindow.start), "Last stop by": dateTime(newWindow.end), Driver: a ? `${a.driver.name}${reconfirm ? ", confirm again" : ""}` : null },
        at: now
      },
      tx
    );
  });
}
