import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { describePay } from "@/lib/audit-diff";
import { driverBlocker } from "@/lib/clearance";
import { dateTime, usd } from "@/lib/desk-format";
import { loadWindow, windowsOverlap, type StopWindow, type Window } from "@/lib/schedule";
import { PAY_KIND_KEYS, PERCENT_MAX, rateConTotal } from "@/lib/pay";
import { loadSecrets } from "@/lib/secret-text";
import { assertDriverSafe, contractorMoney, driverFacingPay, payEstimate, projectLoadToSummary, type AssignmentPay, type LoadSummary, type PayKind } from "./projector";
import { num, numOrNull } from "./convert";
import { recordAudit } from "./audit";
import { loadStatusFor } from "@/lib/load-state";
import { freezeLoadSnapshot } from "./snapshot";
import { driveHoursFor } from "./evaluate";
import { lockWorkspace } from "./plan";
import { claimAssignment, claimLoad, dropAssignment, LoadMoved } from "./claim";
import { currentWorkspaceId } from "./workspace";
import { inScope, type Terminals } from "@/lib/scope";
import { inTerminal } from "./terminal-sql";
import { allowedFor, currentAllowed } from "./scope";
import { enqueueBridge } from "@/server/bridge/outbox";
import { UNDO_ACCEPT_REASON } from "@/server/bridge/core";
import { recordAssignmentEvent } from "./assignment-events";
import { writePositioningLeg } from "./relay-legs";
import { MILES_SOURCES, type MilesSource } from "@/lib/relay";
import { isOfferedRecallCode, isRecallCode, recallReasonText, type RecallCode } from "@/lib/recall-reasons";
import { resolveIsContractor, type PayArrangement, type PayMilesBasis } from "@/lib/pay-arrangement";
import { senderNameOf } from "@/lib/driver-messages";
import { currentActor } from "./identity";
import { missingReasons, needsMessage, reasonText, type ReasonNeed, type Reasons } from "@/lib/assign-reasons";
import { truckFit } from "@/lib/load-fit";
import { loadSpecsOf, truckLimits } from "./truck-fit";

export { driverBlocker };

/**
 * Assignment is desktop-owned; execution is mobile-owned (bridge contract). The dispatcher picks a driver and a pay,
 * sends it, and later reads the driver's answer. Status: draft | dispatched | accepted | declined | in_progress | completed.
 * Every change here writes an audit event in the same transaction.
 */
export type DispatchStatus = "draft" | "dispatched" | "accepted" | "declined" | "in_progress" | "completed";

const PAY_KINDS: readonly PayKind[] = PAY_KIND_KEYS;
const SENDABLE_LOAD_STATUSES = ["draft", "accepted"];
const OPEN_ASSIGNMENT = ["draft", "dispatched", "accepted", "in_progress"];
const OPEN_LOAD = ["draft", "accepted", "in_progress"];
/** A load dropped at a relay point by a hook or a rescue has left its truck, so the truck is not on it any more (a driver swap keeps the truck on the load). */
const LEFT_ITS_TRUCK: Prisma.LoadWhereInput = { NOT: { handoffs: { some: { state: { in: ["dropped", "disputed"] }, type: { not: "slip_seat" } } } } };

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
      | "not_ready"
      | "double_booked"
      | "driver_outside_limit"
      | "reason_required"
      | "not_unassignable"
      | "not_allowed"
      | "bad_reason"
      | "bad_fee"
      | "bad_time"
      | "reasons_needed"
      | "stale"
      | "no_default_pay",
    message: string,
    /** For "reasons_needed": every condition still without its reason, so the screen can ask for each one at once. */
    readonly needs: ReasonNeed[] = []
  ) {
    super(message);
  }
}

/** The most a pay rate can be, per kind: far above any real one and far below what the columns hold. */
const MAX_PAY_RATE: Record<string, number> = { cpm: 10, hourly: 500, flat: 100_000 };

export function assertPay(pay: AssignmentPay): void {
  if (!PAY_KINDS.includes(pay.kind) || !Number.isFinite(pay.rate) || pay.rate <= 0) {
    throw new DispatchError("bad_pay", "Pay needs a kind (per mile, hourly, a set amount or a percent of the rate) and a rate above zero.");
  }
  // Past what any real pay is: a typed 25 under "percent" left in place when the kind is changed to per mile is the slip this stops.
  if (pay.kind !== "percent" && pay.rate > MAX_PAY_RATE[pay.kind]) {
    throw new DispatchError("bad_pay", `${pay.rate.toLocaleString("en-US")} is more than a ${pay.kind === "cpm" ? "per-mile" : pay.kind === "hourly" ? "hourly" : "set"} pay can be (at most ${MAX_PAY_RATE[pay.kind].toLocaleString("en-US")}). Check the amount and the kind.`);
  }
  if (pay.kind === "percent" && pay.rate > PERCENT_MAX) {
    throw new DispatchError("bad_pay", `A percent of the rate has to be above 0 and under 100.`);
  }
}

export const windowText = (w: Window) => `${dateTime(w.start)} to ${dateTime(w.end)}`;

/** Another open load this driver already holds whose window overlaps `win`, or null. */
export async function findDriverClash(driverId: string, exceptLoadId: string, win: Window | null, db: Pick<typeof prisma, "assignment"> = prisma): Promise<{ loadNumber: string | null; window: Window } | null> {
  if (!win) return null;
  const others = await db.assignment.findMany({
    where: { driverId, loadId: { not: exceptLoadId }, status: { in: OPEN_ASSIGNMENT }, load: { deletedAt: null, status: { in: OPEN_LOAD } } },
    include: { load: { include: { stops: true } } }
  });
  for (const o of others) {
    const w = loadWindow(o.load.stops);
    if (w && windowsOverlap(win, w)) return { loadNumber: o.load.loadNumber, window: w };
  }
  return null;
}

/**
 * Another open load this TRUCK is on whose window overlaps `win`, or null. A truck is on one load at a time, whoever drives it; the driver check above does not see a truck two
 * dispatchers have put on two loads at once.
 */
export async function findTruckClash(vehicleId: string, exceptLoadId: string, win: Window | null, workspaceId = currentWorkspaceId(), db: Pick<typeof prisma, "load"> = prisma): Promise<{ loadNumber: string | null; window: Window } | null> {
  if (!win) return null;
  const others = await db.load.findMany({ where: { workspaceId, vehicleId, ...(exceptLoadId ? { id: { not: exceptLoadId } } : {}), deletedAt: null, status: { in: OPEN_LOAD }, ...LEFT_ITS_TRUCK }, include: { stops: true } });
  for (const o of others) {
    const w = loadWindow(o.stops);
    if (w && windowsOverlap(win, w)) return { loadNumber: o.loadNumber, window: w };
  }
  return null;
}

/** For the driver picker: who is already busy at the time of this load. */
export async function driverClashNote(driverId: string, exceptLoadId: string, stops: StopWindow[]): Promise<string | null> {
  const clash = await findDriverClash(driverId, exceptLoadId, loadWindow(stops));
  return clash ? `already on ${clash.loadNumber ?? "another load"}` : null;
}

/**
 * The same note for many drivers at once, in one query: who is already on another open load at the time of this one. A fleet has thousands of drivers and
 * only hundreds of open loads, so asking per driver (a query each) is what made a list of drivers slow; this reads the open assignments of the drivers asked about.
 */
export async function driverClashNotes(driverIds: string[], exceptLoadId: string, stops: StopWindow[]): Promise<Map<string, string>> {
  const found = await driverClashesIn(driverIds, exceptLoadId, loadWindow(stops));
  return new Map([...found].map(([id, loadNumber]) => [id, `already on ${loadNumber ?? "another load"}`]));
}

/** For each of these drivers, the number of another open load they hold whose window overlaps `win` (null when it has no number). One query for all of them. */
export async function driverClashesIn(driverIds: string[], exceptLoadId: string, win: Window | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!win || driverIds.length === 0) return out;
  const others = await prisma.assignment.findMany({
    where: { driverId: { in: driverIds }, loadId: { not: exceptLoadId }, status: { in: OPEN_ASSIGNMENT }, load: { deletedAt: null, status: { in: OPEN_LOAD } } },
    select: { driverId: true, load: { select: { loadNumber: true, stops: { select: { timeWindowEarliest: true, timeWindowLatest: true } } } } }
  });
  for (const o of others) {
    if (out.has(o.driverId)) continue;
    const w = loadWindow(o.load.stops);
    if (w && windowsOverlap(win, w)) out.set(o.driverId, o.load.loadNumber);
  }
  return out;
}

/** Which trucks are already on another open load at that time, for many trucks at once (one query): truck id to the other load's number. */
export async function truckClashesIn(vehicleIds: string[], exceptLoadId: string, win: Window | null, workspaceId = currentWorkspaceId()): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!win || vehicleIds.length === 0) return out;
  const others = await prisma.load.findMany({ where: { workspaceId, vehicleId: { in: vehicleIds }, ...(exceptLoadId ? { id: { not: exceptLoadId } } : {}), deletedAt: null, status: { in: OPEN_LOAD }, ...LEFT_ITS_TRUCK }, select: { vehicleId: true, loadNumber: true, stops: { select: { timeWindowEarliest: true, timeWindowLatest: true } } } });
  for (const o of others) {
    if (!o.vehicleId || out.has(o.vehicleId)) continue;
    const w = loadWindow(o.stops);
    if (w && windowsOverlap(win, w)) out.set(o.vehicleId, o.loadNumber);
  }
  return out;
}

/** Dollars and cents as the desk says them everywhere: grouped, with a real minus (src/lib/desk-format.ts). */
const money = (n: number) => usd(n, 2);

/**
 * Create or replace the draft assignment for a load. A load that was already sent keeps its row and bumps the version.
 * A driver who is already on another open load at the same time is refused unless the dispatcher gives a reason.
 */
/** The hours a trip takes, for an hourly driver's estimate: the load's drive time over every mile it counts (the way home too, unless a load covers it), to the hundredth of an hour. */
export function tripHoursOf(load: { pickupDeadheadMiles: unknown; loadedMiles: unknown; returnDeadheadMiles: unknown; isBackhaul: boolean; estimatedLoadedHours?: unknown }): number {
  const total = num(load.pickupDeadheadMiles as never) + num(load.loadedMiles as never) + (load.isBackhaul ? 0 : num(load.returnDeadheadMiles as never));
  return new Prisma.Decimal(driveHoursFor({ estimatedLoadedHours: load.estimatedLoadedHours as never, loadedMiles: load.loadedMiles as never }, total)).toDecimalPlaces(2).toNumber();
}

export async function assignDriver(
  input: {
    loadId: string;
    driverId: string;
    pay: AssignmentPay;
    estimatedHours?: number | null;
    /** One reason per condition (src/lib/assign-reasons.ts): the screens send these. */
    reasons?: Reasons;
    /** Older callers (scripts, tests): one reason that covers a double-book and a change of driver, the two it always covered, and nothing added since. The screens send `reasons`. */
    overrideReason?: string | null;
    /** What the dispatcher saw when they opened the window: the assignment's version and driver then (null: none). Someone else's change since is refused, never written over. */
    expected?: { assignmentVersion: number | null; driverId: string | null } | null;
    /** The person's limit (null: not limited); read from the request when left out. Tests and scripts stand in for a request with it. */
    allowed?: Terminals;
  },
  now = new Date(),
  workspaceId = currentWorkspaceId()
) {
  assertPay(input.pay);
  // A person limited to some terminals reaches only the loads and drivers of those terminals (a load not placed anywhere yet is everyone's), whatever id arrives.
  const allowed = input.allowed !== undefined ? input.allowed : await currentAllowed(workspaceId);
  // Both ids are looked up inside the workspace: another workspace's load or driver is "not found", never acted on.
  const load = await prisma.load.findFirst({ where: { id: input.loadId, workspaceId, ...inTerminal(allowed) }, include: { assignment: { include: { driver: true } }, stops: true } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  if (!SENDABLE_LOAD_STATUSES.includes(load.status)) throw new DispatchError("load_not_assignable", `A ${load.status} load cannot be assigned.`);
  const driver = await prisma.driver.findFirst({ where: { id: input.driverId, workspaceId } });
  if (!driver || !driver.active) throw new DispatchError("driver_not_found", "That driver is not available.");
  if (!inScope(allowed, driver.terminal)) throw new DispatchError("driver_outside_limit", `${driver.name} is based outside the terminals you work. Ask an admin to change what you can see, or to assign them.`);
  // Good for the whole trip, not just today: a card that lapses before the last delivery window closes blocks (src/lib/clearance.ts).
  const blocker = driverBlocker(driver, now, loadWindow(load.stops)?.end ?? load.scheduledDate ?? null);
  if (blocker) throw new DispatchError("driver_not_cleared", `${driver.name}: ${blocker}.`);

  // The truck goes with the driver: a load with no truck takes the truck this driver usually drives (inside the person's limit), so its cost floor, its verdict and the truck checks are
  // real. The same rules as a relay hand-over (relay.ts): a truck that cannot carry the load refuses, one already on another load at that time needs its own reason.
  const attach =
    load.vehicleId == null && driver.assignedVehicleId
      ? await prisma.vehicle.findFirst({ where: { id: driver.assignedVehicleId, workspaceId, archivedAt: null } })
      : null;
  const truck = attach && inScope(allowed, attach.terminal) ? attach : null;
  if (truck) {
    const fit = truckFit(loadSpecsOf(load), truckLimits(truck));
    if (fit.blocker) throw new DispatchError("load_not_assignable", `${truck.name ?? "Their truck"} would go on this load with ${driver.name}, and it cannot take it. ${fit.blocker}`);
  }
  const truckName = truck?.name ?? "Their truck";

  const reasons: Reasons = { ...(input.reasons ?? {}) };
  const legacy = (input.overrideReason ?? "").trim();
  if (legacy) {
    reasons.double_booked ??= legacy;
    reasons.reason_required ??= legacy;
  }

  // An hourly driver is paid for the trip's hours, so the estimate needs them: the hours typed, else the load's own drive time (measured when it was quoted, else 50 mph over every mile).
  const estimate = payEstimate(input.pay, num(load.loadedMiles), input.estimatedHours ?? (input.pay.kind === "hourly" ? tripHoursOf(load) : null), rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge)));
  const data = {
    driverId: driver.id,
    payKind: input.pay.kind,
    payRate: new Prisma.Decimal(input.pay.rate),
    payEstimate: estimate
  };
  const payText = describePay(input.pay.kind, input.pay.rate);
  const prev = load.assignment;
  const held = prev != null && (prev.status === "dispatched" || prev.status === "accepted");
  // A driver who already has the load (sent to them, or accepted) is not swapped for another without a reason, as taking them off it needs one.
  const replacing = held && prev!.driverId !== driver.id;
  // The same driver, already holding it: a change of pay is a new offer (their phone's is taken back and it is sent again), so it needs a reason; no change at all is nothing to do.
  const samePay = prev != null && prev.payKind === input.pay.kind && new Prisma.Decimal(prev.payRate).equals(input.pay.rate) && num(prev.payEstimate) === num(estimate);
  const repaid = held && !replacing && !samePay;
  if (held && !replacing && samePay) return prev!;

  // Every condition that needs a reason, each with its own: the dispatcher sees them all at once and a reason typed for one never covers another.
  const needs: ReasonNeed[] = [];
  const clash = await findDriverClash(driver.id, load.id, loadWindow(load.stops));
  if (clash) needs.push({ code: "double_booked", message: `${driver.name} is already on ${clash.loadNumber ?? "another load"} (${windowText(clash.window)}).` });
  if (replacing) needs.push({ code: "reason_required", message: `${prev!.driver.name} has this load.` });
  const truckBusy = truck ? await findTruckClash(truck.id, load.id, loadWindow(load.stops), workspaceId) : null;
  if (truckBusy) needs.push({ code: "truck_busy", message: `${truckName} is already on ${truckBusy.loadNumber ?? "another load"} (${windowText(truckBusy.window)}).` });
  if (repaid) needs.push({ code: "pay_changed", message: `${driver.name} was sent this load at ${describePay(prev!.payKind, num(prev!.payRate))}. The offer on their phone is taken back and the load has to be sent again.` });
  const missing = missingReasons(needs, reasons);
  if (missing.length > 0) throw new DispatchError("reasons_needed", needsMessage(missing), missing);

  return prisma.$transaction(async (tx) => {
    // The clash was checked above, before this transaction; two dispatchers assigning one driver to two loads at once would both have passed it. Checked again here, with the desk
    // locked, so the second one sees the first.
    await lockWorkspace(tx, workspaceId);
    // The load was read before the lock: re-read it here. One that was picked up, delivered, cancelled or deleted in between is not put back to a draft with a new driver.
    const fresh = await tx.load.findFirst({ where: { id: load.id, workspaceId, deletedAt: null }, select: { status: true, assignment: { select: { assignmentVersion: true, driverId: true } } } });
    if (!fresh || !["draft", "accepted"].includes(fresh.status)) throw new DispatchError("load_not_assignable", "That load has started, finished or been cancelled since you opened it. Reload it.");
    // What the dispatcher saw when they opened the window is still what is there: another dispatcher's assignment since then is refused, never written over.
    if (input.expected) {
      const nowA = fresh.assignment;
      if ((nowA?.assignmentVersion ?? null) !== input.expected.assignmentVersion || (nowA?.driverId ?? null) !== input.expected.driverId) {
        throw new DispatchError("stale", "Someone else changed the driver on this load since you opened it. Reload it to see who has it.");
      }
    }
    if (!clash) {
      const now2 = await findDriverClash(driver.id, load.id, loadWindow(load.stops), tx);
      if (now2) {
        const need: ReasonNeed = { code: "double_booked", message: `${driver.name} is already on ${now2.loadNumber ?? "another load"} (${windowText(now2.window)}).` };
        if (missingReasons([need], reasons).length > 0) throw new DispatchError("reasons_needed", needsMessage([need]), [need]);
        needs.push(need);
      }
    }
    if (truck && !truckBusy) {
      const busyNow = await findTruckClash(truck.id, load.id, loadWindow(load.stops), workspaceId, tx);
      if (busyNow) {
        const need: ReasonNeed = { code: "truck_busy", message: `${truckName} is already on ${busyNow.loadNumber ?? "another load"} (${windowText(busyNow.window)}).` };
        if (missingReasons([need], reasons).length > 0) throw new DispatchError("reasons_needed", needsMessage([need]), [need]);
        needs.push(need);
      }
    }
    // Only while the load still has no truck: one set by someone else in the meantime is theirs to keep.
    const truckSet = truck ? (await tx.load.updateMany({ where: { id: load.id, workspaceId, vehicleId: null }, data: { vehicleId: truck.id } })).count === 1 : false;
    const saved = prev
      ? await tx.assignment.update({
          where: { loadId: load.id },
          data: { ...data, status: "draft", driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 }, dispatchedAt: null, respondedAt: null }
        })
      : await tx.assignment.create({ data: { loadId: load.id, status: "draft", ...data } });
    // The driver who had it on their phone (another one, or the same one at the old pay) has that offer taken back; the load goes again when the dispatcher sends it.
    if (prev && (replacing || repaid)) await enqueueBridge(tx, { workspaceId, loadId: load.id, kind: "reassign_old", driverId: prev.driverId, now });
    // A new driver has not said yes: a load that was accepted by the last one goes back to draft with the assignment (src/lib/load-state.ts).
    if (load.status !== loadStatusFor("draft")) await tx.load.update({ where: { id: load.id }, data: { status: loadStatusFor("draft") } });
    // Who is driving, and at what pay, is now known: freeze it with the rest of what the load was booked with.
    await freezeLoadSnapshot(tx, load.id, { labour: true });
    const why = reasonText(needs, reasons);
    const prevPay = prev ? describePay(prev.payKind, num(prev.payRate)) : null;
    await recordAudit(
      {
        entity: "assignment",
        action: prev ? "reassigned" : "assigned",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary:
          (prev
            ? prev.driverId === driver.id && prevPay === payText
              ? `${driver.name} assigned again at ${payText}`
              : prev.driverId === driver.id
                ? `${driver.name}'s pay changed from ${prevPay} to ${payText}`
                : `Changed from ${prev.driver.name} (${prevPay}) to ${driver.name} (${payText})`
            : `${driver.name} assigned at ${payText}`) + (truckSet ? `, on ${truckName}` : "") + (needs.some((n) => n.code === "double_booked") ? ", double-booked on purpose" : ""),
        reason: why,
        before: prev ? { Driver: prev.driver.name, Pay: prevPay, Estimate: money(num(prev.payEstimate)) } : null,
        after: { Driver: driver.name, Pay: payText, Estimate: money(num(estimate)) },
        at: now, workspaceId
      },
      tx
    );
    await recordAssignmentEvent(tx, { workspaceId, loadId: load.id, loadNumber: load.loadNumber, kind: prev ? "reassigned" : "assigned", driverId: driver.id, driverName: driver.name, reasonNote: why, assignmentVersion: saved.assignmentVersion, at: now });
    return saved;
  });
}

/**
 * Take the driver off a load (a recall). A load that was sent or accepted needs a reason CODE (src/lib/recall-reasons.ts), with an optional note; the code and the note go in the audit trail
 * and in the holder trail (AssignmentEvent), and the driver's phone is told through the driver link. An accepted load goes back to the board as a draft. A driver who was never sent the
 * load comes off with no reason (a correction, not a recall). A load already on the road or delivered cannot be unassigned here: on the road it is a handoff (src/server/tl/relay.ts).
 * `positioning` is for a driver who accepted and was already rolling empty to the pickup when they were recalled: the miles they drove are kept on a closed positioning leg, with where the figure
 * came from, so they are paid for them (docs/RELAY_DESIGN.md, sign-off 1). It needs a recall reason, and an accepted load.
 */
export async function unassignLoad(loadId: string, reason: string | null, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals, code?: RecallCode | null, positioning?: { milesDriven: number | null; milesSource: MilesSource | null }) {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, ...inTerminal(allowed !== undefined ? allowed : await currentAllowed(workspaceId)) }, include: { assignment: { include: { driver: true } }, stops: { orderBy: { stopSequence: "asc" } }, vehicle: { select: { name: true } }, trailer: { select: { number: true } } } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  const a = load.assignment;
  if (!a) throw new DispatchError("not_assigned", "There is no driver on this load.");
  if (!["draft", "accepted"].includes(load.status) || ["in_progress", "completed"].includes(a.status)) {
    throw new DispatchError("not_unassignable", "A load that is on the road or delivered cannot be unassigned here. Use Hand off to another driver in the Relay section.");
  }
  const note = (reason ?? "").trim();
  const needsReason = a.status === "dispatched" || a.status === "accepted";
  if (needsReason && !code) throw new DispatchError("reason_required", "Say why the driver is coming off a load that was already sent: pick a reason.");
  if (code && !isRecallCode(code)) throw new DispatchError("bad_reason", "That is not a reason a load can be recalled for.");
  if (code && !isOfferedRecallCode(code)) throw new DispatchError("bad_reason", "A scheduled relay is handled in the Relay section once on the road, not as a recall.");
  const why = code ? recallReasonText(code, note) : note;
  if (positioning) {
    if (!needsReason || a.status !== "accepted") throw new DispatchError("bad_reason", "Miles driven are kept only when a driver who accepted the load is recalled while rolling empty to the pickup.");
    const m = positioning.milesDriven;
    if (m != null && (!Number.isFinite(m) || m < 0 || m > 5000)) throw new DispatchError("bad_reason", "Miles driven must be between 0 and 5,000.");
    if (m != null && !(MILES_SOURCES as readonly string[]).includes(positioning.milesSource ?? "")) throw new DispatchError("bad_reason", "Say where the miles came from: the ELD, the driver, or you.");
  }

  await prisma.$transaction(async (tx) => {
    // The driver's phone is told the load is off them (the row is closed, never deleted: that is the phone's signal).
    if (needsReason) await enqueueBridge(tx, { workspaceId, loadId, kind: "cancel", driverId: a.driverId, now });
    try {
      // The load has to still be the state it was read in (not picked up, cancelled or deleted since), and the assignment is taken off once.
      await claimLoad(tx, loadId, workspaceId, ["draft", "accepted"], load.status === "accepted" ? { status: "draft" } : {});
      if (positioning) await writePositioningLeg(tx, load, a, { milesDriven: positioning.milesDriven, milesSource: positioning.milesSource, now });
      await dropAssignment(tx, loadId);
    } catch (e) {
      if (e instanceof LoadMoved) throw new DispatchError("not_unassignable", e.message);
      throw e;
    }
    await recordAudit(
      {
        entity: "assignment",
        action: "unassigned",
        loadId,
        loadNumber: load.loadNumber,
        summary: needsReason ? `${a.driver.name} recalled from the load` : `${a.driver.name} taken off the load`,
        reason: why || null,
        before: { Driver: a.driver.name, Pay: describePay(a.payKind, num(a.payRate)), Status: a.status === "dispatched" ? "Sent, waiting" : a.status === "accepted" ? "Driver accepted" : a.status === "declined" ? "Driver declined" : "Assigned, not sent" },
        after: { Driver: null, Pay: null, Status: "Needs a driver" },
        at: now, workspaceId
      },
      tx
    );
    await recordAssignmentEvent(tx, { workspaceId, loadId, loadNumber: load.loadNumber, kind: needsReason ? "recalled" : "removed", driverId: a.driverId, driverName: a.driver.name, reasonCode: code ?? null, reasonNote: note || null, assignmentVersion: a.assignmentVersion, at: now });
  });
}

/**
 * Workspace-level driver pay defaults: arrangement (`company` | `contractor`) and per-mile basis (`logged` | `billable`).
 */
export async function workspacePaySettings(
  workspaceId = currentWorkspaceId(),
  db: Pick<typeof prisma, "workspace"> = prisma
): Promise<{ defaultPayArrangement: PayArrangement; payMilesBasis: PayMilesBasis }> {
  const ws = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { defaultPayArrangement: true, payMilesBasis: true }
  });
  return {
    defaultPayArrangement: ws?.defaultPayArrangement === "contractor" ? "contractor" : "company",
    payMilesBasis: ws?.payMilesBasis === "billable" ? "billable" : "logged"
  };
}

/**
 * Whether this driver is paid as a contractor:
 * 1) explicit desk `driver.payArrangement` (`company` | `contractor`),
 * 2) live claimed phone link role (`owner_op_leased`),
 * 3) workspace `defaultPayArrangement` (default `company`).
 */
export async function driverIsContractor(
  driverId: string,
  workspaceId = currentWorkspaceId(),
  db: Partial<Pick<typeof prisma, "driver" | "workspace" | "driverLinkInvite">> = prisma
): Promise<boolean> {
  const [driver, live, ws] = await Promise.all([
    db.driver ? db.driver.findFirst({ where: { id: driverId, workspaceId }, select: { payArrangement: true } }) : Promise.resolve(null),
    db.driverLinkInvite
      ? db.driverLinkInvite.findFirst({ where: { workspaceId, driverId, claimedAt: { not: null }, revokedAt: null }, orderBy: { claimedAt: "desc" }, select: { driverRole: true } })
      : Promise.resolve(null),
    db.workspace ? db.workspace.findUnique({ where: { id: workspaceId }, select: { defaultPayArrangement: true } }) : Promise.resolve(null)
  ]);
  return resolveIsContractor({
    driverArrangement: driver?.payArrangement,
    inviteRole: live?.driverRole,
    workspaceDefault: ws?.defaultPayArrangement
  });
}

/** What the driver is sent: the driver-safe summary, checked against the confidentiality gate before it goes anywhere. A contractor also gets their load's gross and the fee. */
export async function driverSummaryFor(loadId: string, workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<LoadSummary> {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, ...inTerminal(scope) }, include: { stops: true, assignment: true } });
  if (!load || load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  if (!load.assignment) throw new DispatchError("not_assigned", "Assign a driver first.");
  const assignmentPay: AssignmentPay = { kind: load.assignment.payKind as PayKind, rate: num(load.assignment.payRate) };
  const total = rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge));
  const pay = driverFacingPay(assignmentPay, total);
  const summary = projectLoadToSummary(
    {
      loadNumber: load.loadNumber,
      poNumber: load.poNumber,
      brokerName: load.brokerName,
      trailerType: load.trailerType,
      originAddress: load.originAddress,
      destinationAddress: load.destinationAddress,
      loadedMiles: num(load.loadedMiles),
      weightLbs: load.weightLbs,
      estimatedHours: load.assignment.payKind === "hourly" ? tripHoursOf(load) : null,
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
  // Who sent it, by name only (the phone's "From <company> · <name>").
  const by = senderNameOf(load.assignment.dispatchedBy);
  if (by) summary.dispatcher = { name: by };
  const contractor = await driverIsContractor(load.assignment.driverId, workspaceId);
  if (contractor) summary.contractor = contractorMoney(assignmentPay, total, summary.driver_pay.estimate);
  try {
    assertDriverSafe(summary, { numbers: loadSecrets(load) }, { contractor });
  } catch (e) {
    // A note that says what the load pays is the one real case: say where, so it can be reworded, instead of an error page.
    const m = e instanceof Error ? /secret value: ([\d.]+) \(in ([^)]+)\)/.exec(e.message) : null;
    if (m) throw new DispatchError("not_ready", `A note on this load repeats an amount that is the load's own money (${m[1]}), which a driver must not see. Reword the stop notes and send it again.`);
    throw e;
  }
  return summary;
}

/** Send the assignment to the driver: status becomes dispatched and the version is bumped. */
export async function dispatchLoad(loadId: string, now = new Date(), opts: { sentWithout?: string } = {}, workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const summary = await driverSummaryFor(loadId, workspaceId, scope); // throws if not assigned, not in this workspace/terminal, or if anything would leak
  const a = await prisma.assignment.findFirstOrThrow({ where: { loadId, load: { workspaceId, ...inTerminal(scope) } }, include: { driver: true, load: true } });
  if (a.status !== "draft") throw new DispatchError("already_sent", "This load was already sent to the driver.");
  const updated = await prisma.$transaction(async (tx) => {
    // The load itself is still on the desk and still sendable, checked again inside this transaction: a delete that lands between the read above and here is either waited for
    // (the row is locked) or makes this send fail, so a phone is never offered a load that was just deleted.
    try {
      await claimLoad(tx, loadId, workspaceId, SENDABLE_LOAD_STATUSES, {}, inTerminal(scope) as Prisma.LoadWhereInput);
    } catch (e) {
      if (e instanceof LoadMoved) throw new DispatchError("load_not_assignable", "That load was deleted, started or cancelled since you opened it. Reload it.");
      throw e;
    }
    // Sent once: a second press (or another tab) finds it already sent.
    try {
      await claimAssignment(tx, loadId, ["draft"], { status: "dispatched", dispatchedAt: now, dispatchedBy: senderNameOf(currentActor()), assignmentVersion: { increment: 1 } });
    } catch (e) {
      if (e instanceof LoadMoved) throw new DispatchError("already_sent", "This load was already sent to the driver.");
      throw e;
    }
    const next = await tx.assignment.findUniqueOrThrow({ where: { loadId } });
    await recordAudit(
      {
        entity: "assignment",
        action: "sent",
        loadId,
        loadNumber: a.load.loadNumber,
        summary: `Sent to ${a.driver.name}${opts.sentWithout ? `, without ${opts.sentWithout}` : ""}`,
        before: { Status: "Assigned, not sent" },
        after: { Status: "Sent, waiting" },
        at: now, workspaceId
      },
      tx
    );
    await recordAssignmentEvent(tx, { workspaceId, loadId, loadNumber: a.load.loadNumber, kind: "sent", driverId: a.driverId, driverName: a.driver.name, assignmentVersion: next.assignmentVersion, at: now });
    // A driver with a phone account is told through the driver link, in this same transaction (docs/DRIVER_LINK_DESIGN.md); any other driver is answered for by the dispatcher.
    await enqueueBridge(tx, { workspaceId, loadId, kind: "dispatch", driverId: a.driverId, now });
    return next;
  });
  return { assignment: updated, summary };
}

/**
 * The driver's answer, as the phone would write it back (respond_to_dispatch). Accepting moves the load to accepted;
 * declining returns the load to the board unassigned-able. The desktop never writes the driver's execution fields.
 */
export async function recordDriverResponse(loadId: string, response: "accepted" | "declined", now = new Date(), note?: string, workspaceId = currentWorkspaceId(), via: "dispatcher" | "phone" = "dispatcher", allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  const a = await prisma.assignment.findFirst({ where: { loadId, load: { workspaceId, ...inTerminal(scope) } }, include: { driver: true, load: true } });
  if (!a) throw new DispatchError("not_assigned", "Assign a driver first.");
  // The one way back: the driver takes back an accept made in error on their phone, before the pickup (server/bridge/core.ts UNDO_ACCEPT_REASON).
  const undo = response === "declined" && via === "phone" && a.status === "accepted" && note === UNDO_ACCEPT_REASON;
  if (a.status !== "dispatched" && !undo) throw new DispatchError("not_sent", "Send the load to the driver before recording an answer.");
  if (a.load.deletedAt) throw new DispatchError("load_not_found", "That load does not exist.");
  return prisma.$transaction(async (tx) => {
    // Answered once: the answer only lands on an assignment that is still waiting for one, on a load that is still on the desk.
    try {
      await claimAssignment(tx, loadId, [undo ? "accepted" : "dispatched"], { status: response, respondedAt: now, driverResponse: { response, note: note ?? null, at: now.toISOString() } });
      // The load's status follows the assignment's in the same transaction: yes is accepted, a no is back on the board as a draft.
      await claimLoad(tx, loadId, workspaceId, [a.load.status], { status: loadStatusFor(response) }, inTerminal(scope) as Prisma.LoadWhereInput);
    } catch (e) {
      if (e instanceof LoadMoved) throw new DispatchError("not_sent", "That answer was already recorded, or the load changed. Reload it.");
      throw e;
    }
    const assignment = await tx.assignment.findUniqueOrThrow({ where: { loadId } });
    await recordAudit(
      {
        entity: "assignment",
        action: response,
        loadId,
        loadNumber: a.load.loadNumber,
        // Who gave the answer is part of the record: the driver on their phone, or the dispatcher answering for them (a driver out of coverage, or a phone that is not connected).
        summary: undo ? `${a.driver.name} took back their accept on their phone (accepted in error)` : `${a.driver.name} ${response === "accepted" ? "accepted" : "declined"}${via === "phone" ? " on their phone" : " (answered for them by the dispatcher)"}`,
        reason: note ?? null,
        before: { Status: undo ? "Driver accepted" : "Sent, waiting" },
        after: { Status: response === "accepted" ? "Driver accepted" : "Driver declined" },
        at: now, workspaceId
      },
      tx
    );
    await recordAssignmentEvent(tx, { workspaceId, loadId, loadNumber: a.load.loadNumber, kind: response, driverId: a.driverId, driverName: a.driver.name, reasonNote: note ?? null, via, assignmentVersion: assignment.assignmentVersion, at: now });
    return assignment;
  });
}
