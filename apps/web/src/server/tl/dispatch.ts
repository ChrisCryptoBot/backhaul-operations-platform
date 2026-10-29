import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertDriverSafe, payEstimate, projectLoadToSummary, type AssignmentPay, type LoadSummary, type PayKind } from "./projector";
import { num, numOrNull } from "./convert";

/**
 * Assignment is desktop-owned; execution is mobile-owned (bridge contract). The dispatcher picks a driver and a pay,
 * sends it, and later reads the driver's answer. Status: draft | dispatched | accepted | declined | in_progress | completed.
 */
export type DispatchStatus = "draft" | "dispatched" | "accepted" | "declined" | "in_progress" | "completed";

const PAY_KINDS: readonly PayKind[] = ["flat", "cpm", "hourly"];
const SENDABLE_LOAD_STATUSES = ["draft", "accepted"];

export class DispatchError extends Error {
  constructor(
    readonly code: "load_not_found" | "driver_not_found" | "bad_pay" | "driver_not_cleared" | "load_not_assignable" | "not_assigned" | "already_sent" | "not_sent",
    message: string
  ) {
    super(message);
  }
}

/** Pure: why a driver cannot take a load today, or null. A lapsed CDL or medical card blocks the assignment. */
export function driverBlocker(d: { cdlExpiry: Date | null; medicalCardExpiry: Date | null }, now = new Date()): string | null {
  if (d.cdlExpiry && d.cdlExpiry.getTime() < now.getTime()) return "CDL expired";
  if (d.medicalCardExpiry && d.medicalCardExpiry.getTime() < now.getTime()) return "Medical card expired";
  return null;
}

export function assertPay(pay: AssignmentPay): void {
  if (!PAY_KINDS.includes(pay.kind) || !Number.isFinite(pay.rate) || pay.rate <= 0) {
    throw new DispatchError("bad_pay", "Pay needs a kind (flat, cpm or hourly) and a rate above zero.");
  }
}

/** Create or replace the draft assignment for a load. A load that was already sent keeps its row and bumps the version. */
export async function assignDriver(input: { loadId: string; driverId: string; pay: AssignmentPay; estimatedHours?: number | null }, now = new Date()) {
  assertPay(input.pay);
  const load = await prisma.load.findUnique({ where: { id: input.loadId }, include: { assignment: true } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  if (!SENDABLE_LOAD_STATUSES.includes(load.status)) throw new DispatchError("load_not_assignable", `A ${load.status} load cannot be assigned.`);
  const driver = await prisma.driver.findUnique({ where: { id: input.driverId } });
  if (!driver || !driver.active) throw new DispatchError("driver_not_found", "That driver is not available.");
  const blocker = driverBlocker(driver, now);
  if (blocker) throw new DispatchError("driver_not_cleared", `${driver.name}: ${blocker}.`);

  const estimate = payEstimate(input.pay, num(load.loadedMiles), input.estimatedHours ?? null);
  const data = {
    driverId: driver.id,
    payKind: input.pay.kind,
    payRate: new Prisma.Decimal(input.pay.rate),
    payEstimate: estimate
  };
  if (load.assignment) {
    return prisma.assignment.update({
      where: { loadId: load.id },
      data: { ...data, status: "draft", driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 }, dispatchedAt: null, respondedAt: null }
    });
  }
  return prisma.assignment.create({ data: { loadId: load.id, status: "draft", ...data } });
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
  const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });
  if (a.status !== "draft") throw new DispatchError("already_sent", "This load was already sent to the driver.");
  const updated = await prisma.assignment.update({
    where: { loadId },
    data: { status: "dispatched", dispatchedAt: now, assignmentVersion: { increment: 1 } }
  });
  return { assignment: updated, summary };
}

/**
 * The driver's answer, as the phone would write it back (respond_to_dispatch). Accepting moves the load to accepted;
 * declining returns the load to the board unassigned-able. The desktop never writes the driver's execution fields.
 */
export async function recordDriverResponse(loadId: string, response: "accepted" | "declined", now = new Date(), note?: string) {
  const a = await prisma.assignment.findUnique({ where: { loadId } });
  if (!a) throw new DispatchError("not_assigned", "Assign a driver first.");
  if (a.status !== "dispatched") throw new DispatchError("not_sent", "Send the load to the driver before recording an answer.");
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.assignment.update({
      where: { loadId },
      data: { status: response, respondedAt: now, driverResponse: { response, note: note ?? null, at: now.toISOString() } }
    });
    if (response === "accepted") await tx.load.update({ where: { id: loadId }, data: { status: "accepted" } });
    return assignment;
  });
}
