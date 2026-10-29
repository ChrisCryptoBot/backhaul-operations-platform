import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { describePay } from "@/lib/audit-diff";
import { driverBlocker } from "@/lib/clearance";
import { dateTime } from "@/lib/desk-format";
import { loadWindow, windowsOverlap, type StopWindow, type Window } from "@/lib/schedule";
import { assertDriverSafe, payEstimate, projectLoadToSummary, type AssignmentPay, type LoadSummary, type PayKind } from "./projector";
import { num, numOrNull } from "./convert";
import { recordAudit } from "./audit";
import { freezeLoadSnapshot } from "./snapshot";

export { driverBlocker };

/**
 * Assignment is desktop-owned; execution is mobile-owned (bridge contract). The dispatcher picks a driver and a pay,
 * sends it, and later reads the driver's answer. Status: draft | dispatched | accepted | declined | in_progress | completed.
 * Every change here writes an audit event in the same transaction.
 */
export type DispatchStatus = "draft" | "dispatched" | "accepted" | "declined" | "in_progress" | "completed";

const PAY_KINDS: readonly PayKind[] = ["flat", "cpm", "hourly"];
const SENDABLE_LOAD_STATUSES = ["draft", "accepted"];
const OPEN_ASSIGNMENT = ["draft", "dispatched", "accepted", "in_progress"];
const OPEN_LOAD = ["draft", "accepted", "in_progress"];

export class DispatchError extends Error {
  constructor(
    readonly code:
      | "load_not_found"
      | "driver_not_found"
      | "bad_pay"
      | "driver_not_cleared"
      | "load_not_assignable"
      | "not_assigned"
      | "already_sent"
      | "not_sent"
      | "double_booked"
      | "reason_required"
      | "not_unassignable"
      | "not_allowed"
      | "bad_reason"
      | "bad_fee"
      | "bad_time",
    message: string
  ) {
    super(message);
  }
}

export function assertPay(pay: AssignmentPay): void {
  if (!PAY_KINDS.includes(pay.kind) || !Number.isFinite(pay.rate) || pay.rate <= 0) {
    throw new DispatchError("bad_pay", "Pay needs a kind (flat, cpm or hourly) and a rate above zero.");
  }
}

const windowText = (w: Window) => `${dateTime(w.start)} to ${dateTime(w.end)}`;

/** Another open load this driver already holds whose window overlaps `win`, or null. */
export async function findDriverClash(driverId: string, exceptLoadId: string, win: Window | null): Promise<{ loadNumber: string | null; window: Window } | null> {
  if (!win) return null;
  const others = await prisma.assignment.findMany({
    where: { driverId, loadId: { not: exceptLoadId }, status: { in: OPEN_ASSIGNMENT }, load: { deletedAt: null, status: { in: OPEN_LOAD } } },
    include: { load: { include: { stops: true } } }
  });
  for (const o of others) {
    const w = loadWindow(o.load.stops);
    if (w && windowsOverlap(win, w)) return { loadNumber: o.load.loadNumber, window: w };
  }
  return null;
}

/** For the driver picker: who is already busy at the time of this load. */
export async function driverClashNote(driverId: string, exceptLoadId: string, stops: StopWindow[]): Promise<string | null> {
  const clash = await findDriverClash(driverId, exceptLoadId, loadWindow(stops));
  return clash ? `already on ${clash.loadNumber ?? "another load"}` : null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Create or replace the draft assignment for a load. A load that was already sent keeps its row and bumps the version.
 * A driver who is already on another open load at the same time is refused unless the dispatcher gives a reason.
 */
export async function assignDriver(input: { loadId: string; driverId: string; pay: AssignmentPay; estimatedHours?: number | null; overrideReason?: string | null }, now = new Date()) {
  assertPay(input.pay);
  const load = await prisma.load.findUnique({ where: { id: input.loadId }, include: { assignment: { include: { driver: true } }, stops: true } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  if (!SENDABLE_LOAD_STATUSES.includes(load.status)) throw new DispatchError("load_not_assignable", `A ${load.status} load cannot be assigned.`);
  const driver = await prisma.driver.findUnique({ where: { id: input.driverId } });
  if (!driver || !driver.active) throw new DispatchError("driver_not_found", "That driver is not available.");
  const blocker = driverBlocker(driver, now);
  if (blocker) throw new DispatchError("driver_not_cleared", `${driver.name}: ${blocker}.`);

  let override: string | null = null;
  const clash = await findDriverClash(driver.id, load.id, loadWindow(load.stops));
  if (clash) {
    const reason = (input.overrideReason ?? "").trim();
    if (reason.length < 3) {
      throw new DispatchError("double_booked", `${driver.name} is already on ${clash.loadNumber ?? "another load"} (${windowText(clash.window)}). Add a reason to assign anyway.`);
    }
    override = reason;
  }

  const estimate = payEstimate(input.pay, num(load.loadedMiles), input.estimatedHours ?? null);
  const data = {
    driverId: driver.id,
    payKind: input.pay.kind,
    payRate: new Prisma.Decimal(input.pay.rate),
    payEstimate: estimate
  };
  const payText = describePay(input.pay.kind, input.pay.rate);
  const prev = load.assignment;

  return prisma.$transaction(async (tx) => {
    const saved = prev
      ? await tx.assignment.update({
          where: { loadId: load.id },
          data: { ...data, status: "draft", driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 }, dispatchedAt: null, respondedAt: null }
        })
      : await tx.assignment.create({ data: { loadId: load.id, status: "draft", ...data } });
    // Who is driving, and at what pay, is now known: freeze it with the rest of what the load was booked with.
    await freezeLoadSnapshot(tx, load.id, { labour: true });
    await recordAudit(
      {
        entity: "assignment",
        action: prev ? "reassigned" : "assigned",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary:
          (prev
            ? prev.driverId === driver.id && describePay(prev.payKind, num(prev.payRate)) === payText
              ? `${driver.name} assigned again at ${payText}`
              : `Changed from ${prev.driver.name} (${describePay(prev.payKind, num(prev.payRate))}) to ${driver.name} (${payText})`
            : `${driver.name} assigned at ${payText}`) + (override ? ", double-booked on purpose" : ""),
        reason: override,
        before: prev ? { Driver: prev.driver.name, Pay: describePay(prev.payKind, num(prev.payRate)), Estimate: money(num(prev.payEstimate)) } : null,
        after: { Driver: driver.name, Pay: payText, Estimate: money(num(estimate)) },
        at: now
      },
      tx
    );
    return saved;
  });
}

/**
 * Take the driver off a load. A load that was sent or accepted needs a reason, which goes in the audit trail.
 * An accepted load goes back to the board as a draft. A load already on the road or delivered cannot be unassigned.
 */
export async function unassignLoad(loadId: string, reason: string | null, now = new Date()) {
  const load = await prisma.load.findUnique({ where: { id: loadId }, include: { assignment: { include: { driver: true } } } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  const a = load.assignment;
  if (!a) throw new DispatchError("not_assigned", "There is no driver on this load.");
  if (!["draft", "accepted"].includes(load.status) || ["in_progress", "completed"].includes(a.status)) {
    throw new DispatchError("not_unassignable", "A load that is on the road or delivered cannot be unassigned.");
  }
  const why = (reason ?? "").trim();
  const needsReason = a.status === "dispatched" || a.status === "accepted";
  if (needsReason && why.length < 3) throw new DispatchError("reason_required", "Say why the driver is coming off a load that was already sent.");

  await prisma.$transaction(async (tx) => {
    await tx.assignment.delete({ where: { loadId } });
    if (load.status === "accepted") await tx.load.update({ where: { id: loadId }, data: { status: "draft" } });
    await recordAudit(
      {
        entity: "assignment",
        action: "unassigned",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${a.driver.name} taken off the load`,
        reason: why || null,
        before: { Driver: a.driver.name, Pay: describePay(a.payKind, num(a.payRate)), Status: a.status === "dispatched" ? "Sent, waiting" : a.status === "accepted" ? "Driver accepted" : a.status === "declined" ? "Driver declined" : "Assigned, not sent" },
        after: { Driver: null, Pay: null, Status: "Needs a driver" },
        at: now
      },
      tx
    );
  });
}

/** What the driver is sent: the driver-safe summary, checked against the confidentiality gate before it goes anywhere. */
export async function driverSummaryFor(loadId: string): Promise<LoadSummary> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, include: { stops: true, assignment: true } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  if (!load.assignment) throw new DispatchError("not_assigned", "Assign a driver first.");
  const pay: AssignmentPay = { kind: load.assignment.payKind as PayKind, rate: num(load.assignment.payRate) };
  const summary = projectLoadToSummary(
    {
      loadNumber: load.loadNumber,
      poNumber: load.poNumber,
      brokerName: load.brokerName,
      trailerType: load.trailerType,
      originAddress: load.originAddress,
      destinationAddress: load.destinationAddress,
      loadedMiles: num(load.loadedMiles),
      stops: load.stops.map((s) => ({
        stopSequence: s.stopSequence,
        stopType: s.stopType,
        stopRole: s.stopRole,
        addressString: s.addressString,
        lat: numOrNull(s.lat),
        lng: numOrNull(s.lng),
        timeWindowEarliest: s.timeWindowEarliest,
        timeWindowLatest: s.timeWindowLatest,
        referenceNumbers: s.referenceNumbers,
        facilityName: s.facilityName,
        stopNotes: s.stopNotes
      }))
    },
    pay
  );
  assertDriverSafe(summary, { numbers: [num(load.quotedRevenue), num(load.actualRevenue), num(load.fuelSurcharge)] });
  return summary;
}

/** Send the assignment to the driver: status becomes dispatched and the version is bumped. */
export async function dispatchLoad(loadId: string, now = new Date()) {
  const summary = await driverSummaryFor(loadId); // throws if not assigned or if anything would leak
  const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId }, include: { driver: true, load: true } });
  if (a.status !== "draft") throw new DispatchError("already_sent", "This load was already sent to the driver.");
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.assignment.update({
      where: { loadId },
      data: { status: "dispatched", dispatchedAt: now, assignmentVersion: { increment: 1 } }
    });
    await recordAudit(
      {
        entity: "assignment",
        action: "sent",
        loadId,
        loadNumber: a.load.loadNumber,
        summary: `Sent to ${a.driver.name}`,
        before: { Status: "Assigned, not sent" },
        after: { Status: "Sent, waiting" },
        at: now
      },
      tx
    );
    return next;
  });
  return { assignment: updated, summary };
}

/**
 * The driver's answer, as the phone would write it back (respond_to_dispatch). Accepting moves the load to accepted;
 * declining returns the load to the board unassigned-able. The desktop never writes the driver's execution fields.
 */
export async function recordDriverResponse(loadId: string, response: "accepted" | "declined", now = new Date(), note?: string) {
  const a = await prisma.assignment.findUnique({ where: { loadId }, include: { driver: true, load: true } });
  if (!a) throw new DispatchError("not_assigned", "Assign a driver first.");
  if (a.status !== "dispatched") throw new DispatchError("not_sent", "Send the load to the driver before recording an answer.");
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.assignment.update({
      where: { loadId },
      data: { status: response, respondedAt: now, driverResponse: { response, note: note ?? null, at: now.toISOString() } }
    });
    if (response === "accepted") await tx.load.update({ where: { id: loadId }, data: { status: "accepted" } });
    await recordAudit(
      {
        entity: "assignment",
        action: response,
        loadId,
        loadNumber: a.load.loadNumber,
        summary: response === "accepted" ? `${a.driver.name} accepted` : `${a.driver.name} declined`,
        reason: note ?? null,
        before: { Status: "Sent, waiting" },
        after: { Status: response === "accepted" ? "Driver accepted" : "Driver declined" },
        at: now
      },
      tx
    );
    return assignment;
  });
}
