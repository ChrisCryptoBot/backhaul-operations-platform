import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
import { loadWindow } from "@/lib/schedule";
import { inScope, type Terminals } from "@/lib/scope";
import { batonDigestText, dropProblems, legPayEstimate, receiveProblems, relayBadge, waitMinutes, type DropInput, type HandoffType, type Problem } from "@/lib/relay";
import { truckFit } from "@/lib/load-fit";
import { rateConTotal } from "@/lib/pay";
import { recordAudit } from "./audit";
import { enqueueBridge } from "@/server/bridge/outbox";
import { recordAssignmentEvent } from "./assignment-events";
import { claimLoad, dropAssignment, LoadMoved } from "./claim";
import { num, numOrNull } from "./convert";
import { assertPay, findDriverClash, findTruckClash, windowText } from "./dispatch";
import { currentActor } from "./identity";
import { senderNameOf } from "@/lib/driver-messages";
import { lockWorkspace } from "./plan";
import { truckLimits } from "./quote";
import { ensureActiveLeg } from "./relay-legs";
import { currentAllowed } from "./scope";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { loadInclude } from "./queries";
import { pickerOptions, rankDrivers } from "./driver-rank";
import { currentTerminal } from "./terminal";
import type { AssignmentPay } from "./projector";

/**
 * Relays: hand a load from one driver to the next (docs/RELAY_DESIGN.md, docs/BATON_CONTRACT_V3.md). The dispatcher records a drop (the outgoing driver left the load at a place), then a
 * receive (the next driver took it), on the drivers' behalf until the phone can do it. Between the two nobody holds the load: the assignment is taken off, the load stays on the road, and
 * the baton waits "in the yard". Every move is made from the state it was read in (claim.ts), writes its audit entry in the same transaction, and keeps its holder-trail row.
 * Not here yet, on purpose: pay for each leg (phase 3: the new driver's assignment carries no estimate, and the closed leg keeps the pay as it stood), photos and documents on the baton and the
 * driver link / phone (phase 4).
 */
export class RelayError extends Error {
  constructor(
    readonly code: "load_not_found" | "not_relayable" | "bad_handoff" | "handoff_not_found" | "not_receivable" | "driver_not_found" | "driver_not_cleared" | "driver_outside_limit" | "double_booked" | "truck_not_found" | "truck_busy" | "trailer_busy" | "bad_discrepancy",
    message: string
  ) {
    super(message);
  }
}

const first = (p: Problem[]) => p[0]!.message;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const place = (h: { locationName: string | null; locationLat: unknown; locationLng: unknown }) => h.locationName?.trim() || (h.locationLat != null ? `${(numOrNull(h.locationLat as never) ?? 0).toFixed(4)}, ${(numOrNull(h.locationLng as never) ?? 0).toFixed(4)}` : "an unnamed place");

/** The baton as a row, for the screens and the digest. */
export type HandoffRow = Awaited<ReturnType<typeof handoffsOfLoad>>[number];

const loadForRelay = (loadId: string, workspaceId: string, allowed: Terminals) =>
  prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(allowed) },
    include: { assignment: { include: { driver: true } }, stops: { orderBy: { stopSequence: "asc" } }, vehicle: { select: { id: true, name: true, terminal: true } }, trailer: true }
  });

/**
 * Record that the driver left the load at a place (a drop). The load must be on the road with a driver, and not already waiting on a baton. The outgoing leg closes with the miles and where
 * they came from; the trailer is unhooked (a planned handoff must not start a dwell leak, so the stay is waived with its reason) unless the truck stays; the assignment is taken off.
 */
export async function recordDrop(loadId: string, input: DropInput, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals, via: "dispatcher" | "phone" = "dispatcher") {
  const problems = dropProblems(input);
  if (problems.length) throw new RelayError("bad_handoff", first(problems));
  const load = await loadForRelay(loadId, workspaceId, allowed !== undefined ? allowed : await currentAllowed(workspaceId));
  if (!load) throw new RelayError("load_not_found", "That load does not exist.");
  const a = load.assignment;
  if (load.status !== "in_progress" || !a || a.status !== "in_progress") throw new RelayError("not_relayable", "Only a load that is on the road with a driver can be handed off. Before the pickup, recall it instead.");
  if (await prisma.handoff.count({ where: { loadId, state: { in: ["dropped", "disputed"] } } })) throw new RelayError("not_relayable", "This load is already waiting on a handoff.");

  const type = input.type as HandoffType;
  const lat = numOrNull(input.lat);
  const lng = numOrNull(input.lng);
  const where = (input.locationName ?? "").trim() || null;
  const tractorStays = type === "slip_seat";

  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    try {
      // Still on the road with this driver: a second tab, a double click or a cancel in between finds nothing to move.
      await claimLoad(tx, loadId, workspaceId, ["in_progress"], {});
    } catch (e) {
      if (e instanceof LoadMoved) throw new RelayError("not_relayable", e.message);
      throw e;
    }
    const leg = await ensureActiveLeg(tx, load, a, now);
    const miles = input.milesDriven ?? null;
    if (a.payKind === "flat" && (input.flatPay == null || input.flatPay <= 0)) {
      throw new RelayError("bad_handoff", "Enter this driver's flat amount for their leg.");
    }
    const effectiveRate = a.payKind === "flat" ? input.flatPay! : num(a.payRate);
    const rcTotal = rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge));
    const est = legPayEstimate(a.payKind, effectiveRate, miles, num(load.loadedMiles), rcTotal);
    await tx.loadLeg.update({
      where: { id: leg.id },
      data: {
        status: "closed",
        endedAt: now,
        toName: where,
        toLat: lat as never,
        toLng: lng as never,
        milesDriven: miles as never,
        milesSource: miles != null ? (input.milesSource as string) : null,
        payKind: a.payKind,
        payRate: new Prisma.Decimal(effectiveRate),
        payEstimate: est != null ? new Prisma.Decimal(est) : null
      }
    });
    const droppedSource = via === "phone" ? "driver" : "dispatcher";
    const h = await tx.handoff.create({
      data: {
        workspaceId,
        loadId,
        type,
        reason: input.reason as string,
        state: "dropped",
        outLegSeq: leg.seq,
        locationName: where,
        locationLat: lat as never,
        locationLng: lng as never,
        locationSlot: (input.slot ?? "").trim() || null,
        locationSetBy: (input.locationSetBy as string | undefined) ?? (via === "phone" ? "emergency_pin" : "dispatcher_typed"),
        tractorOutId: load.vehicleId,
        tractorOutName: load.vehicle?.name ?? null,
        trailerId: load.trailerId,
        trailerNumber: load.trailer?.number ?? null,
        outDriverId: a.driverId,
        outDriverName: a.driver.name,
        sealNumber: (input.sealNumber ?? "").trim() || null,
        reeferSetTemp: (input.reeferSetTemp ?? null) as never,
        reeferActualTemp: (input.reeferActualTemp ?? null) as never,
        reeferFuelPct: input.reeferFuelPct ?? null,
        conditionOk: input.conditionOk ?? null,
        conditionNotes: (input.conditionNotes ?? "").trim() || null,
        outgoingNext: input.outgoingNext as string,
        droppedAt: now,
        droppedSource,
        enteredBy: currentActor(),
        via
      }
    });
    // The trailer stays where it is dropped, and the stay is the plan's, not a leak. A swap keeps the truck and the trailer on it.
    if (!tractorStays && load.trailer && load.trailer.currentVehicleId === load.vehicleId && load.vehicleId) {
      const tractor = await tx.vehicle.findFirst({ where: { id: load.vehicleId, workspaceId }, select: { lastLat: true, lastLng: true, lastLocatedAt: true } });
      const pos = lat != null && lng != null ? { lastLat: lat as never, lastLng: lng as never, lastLocatedAt: now } : tractor?.lastLat != null && tractor.lastLng != null ? { lastLat: tractor.lastLat, lastLng: tractor.lastLng, lastLocatedAt: tractor.lastLocatedAt } : {};
      await tx.trailer.update({ where: { id: load.trailer.id }, data: { currentVehicleId: null, unhookedAt: now, dwellWaived: true, dwellOverrideNote: `Relay handoff on ${load.loadNumber ?? "a load"}`, dwellOverrideBy: currentActor(), dwellOverrideAt: now, ...pos } });
      await tx.trailerMove.create({ data: { workspaceId, trailerId: load.trailer.id, vehicleId: load.vehicleId, kind: "dropped", at: now, lat: (lat ?? tractor?.lastLat ?? null) as never, lng: (lng ?? tractor?.lastLng ?? null) as never, byName: currentActor() } });
      await recordAudit({ entity: "trailer", entityId: load.trailer.id, action: "trailer_unhooked", summary: `${load.trailer.number} dropped for a relay handoff at ${where ?? "a pin"}`, before: { Tractor: load.vehicle?.name ?? null }, after: { Tractor: null }, workspaceId, at: now }, tx);
    }
    // The outgoing driver's phone lets go of the load (queued before the assignment comes off: the outbox reads the driver from it).
    await enqueueBridge(tx, { workspaceId, loadId, kind: "cancel", driverId: a.driverId, now });
    // Nobody holds the load until the next driver takes it: the assignment comes off (the leg keeps who drove it and the pay), the load stays on the road.
    await dropAssignment(tx, loadId);
    await recordAssignmentEvent(tx, { workspaceId, loadId, loadNumber: load.loadNumber, kind: "dropped", driverId: a.driverId, driverName: a.driver.name, reasonNote: where, assignmentVersion: a.assignmentVersion, via, at: now });
    await recordAudit(
      {
        entity: "assignment",
        action: "handoff_dropped",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${a.driver.name} handed off the load at ${place(h)} (${type.replace("_", " ")})`,
        reason: `${input.reason as string}${h.outgoingNext ? `; next: ${h.outgoingNext}` : ""}`,
        before: { Driver: a.driver.name, Status: "On the road" },
        after: { Driver: null, Status: "Awaiting handoff" },
        at: now, workspaceId
      },
      tx
    );
    return h;
  });
}

export type ReceiveInput = {
  driverId: string;
  vehicleId?: string | null;
  pay: AssignmentPay;
  /** What the incoming driver found: did the seal match, was the trailer fine. Null is "not said". */
  sealMatches?: boolean | null;
  conditionOk?: boolean | null;
  conditionNotes?: string | null;
  /** Needed to put a driver or a truck on the load who is already on another one at that time. */
  overrideReason?: string | null;
};

/**
 * The next driver takes custody. Their tap alone transfers it (sign-off 4): nobody else has to release it, unless a discrepancy was reported and dispatch has not acknowledged it. Writes leg N+1,
 * puts the new driver on the load, moves the truck (a rescue or a hook) and hooks the trailer to it, and freezes the baton with a hash of what it said.
 */
export async function receiveHandoff(handoffId: string, input: ReceiveInput, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals, via: "dispatcher" | "phone" = "dispatcher") {
  const h = await prisma.handoff.findFirst({ where: { id: handoffId, workspaceId } });
  if (!h) throw new RelayError("handoff_not_found", "That handoff does not exist.");
  const load = await loadForRelay(h.loadId, workspaceId, allowed !== undefined ? allowed : await currentAllowed(workspaceId));
  if (!load) throw new RelayError("load_not_found", "That load does not exist.");
  const bad = receiveProblems(h, { driverId: input.driverId, vehicleId: input.vehicleId });
  if (bad.length) throw new RelayError("not_receivable", first(bad));
  if (h.state !== "dropped") throw new RelayError("not_receivable", "This handoff was already received.");
  if (load.status !== "in_progress") throw new RelayError("not_relayable", "The load is no longer on the road.");
  try {
    assertPay(input.pay);
  } catch (e) {
    throw new RelayError("bad_handoff", e instanceof Error ? e.message : "That pay is not valid.");
  }

  const driver = await prisma.driver.findFirst({ where: { id: input.driverId, workspaceId } });
  if (!driver || !driver.active) throw new RelayError("driver_not_found", "That driver is not available.");
  const al = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  if (!inScope(al, driver.terminal)) throw new RelayError("driver_outside_limit", `${driver.name} is based outside the terminals you work.`);
  // The next driver has to be cleared through the end of the trip they take over.
  const blocker = driverBlocker(driver, now, loadWindow(load.stops)?.end ?? null);
  if (blocker) throw new RelayError("driver_not_cleared", `${driver.name}: ${blocker}.`);

  const sameTruck = h.type === "slip_seat";
  const vehicleId = sameTruck ? h.tractorOutId : input.vehicleId ?? null;
  const truck = vehicleId
    ? await prisma.vehicle.findFirst({
        where: { id: vehicleId, workspaceId, archivedAt: null },
        select: { id: true, name: true, terminal: true, payloadLbs: true, maxLengthFt: true, maxWidthFt: true, maxHeightIn: true, hasLiftgate: true, hasRamp: true, hasPalletJack: true }
      })
    : null;
  if (vehicleId && !truck) throw new RelayError("truck_not_found", "That truck is not available.");
  if (truck && !sameTruck && !inScope(al, truck.terminal)) throw new RelayError("truck_not_found", `${truck.name ?? "That truck"} is outside the terminals you work.`);
  if (truck && !sameTruck) {
    const fit = truckFit(
      {
        weightLbs: load.weightLbs,
        lengthFt: numOrNull(load.lengthFt),
        widthFt: numOrNull(load.widthFt),
        heightIn: numOrNull(load.loadHeightIn),
        hazmatClass: load.hazmatClass,
        requiresLiftgate: load.requiresLiftgate === true,
        requiresRamp: load.requiresRamp === true,
        requiresPalletJack: load.requiresPalletJack === true
      },
      truckLimits(truck)
    );
    if (fit.blocker) throw new RelayError("bad_handoff", `${truck.name ?? "That truck"} cannot take this load. ${fit.blocker}`);
  }

  // The rest of the load is what the next driver and truck are booked for: from now to the delivery window's close. Another open load in that time needs a reason.
  const whole = loadWindow(load.stops);
  const rest = whole && whole.end.getTime() > now.getTime() ? { start: now, end: whole.end } : null;
  const why = (input.overrideReason ?? "").trim();
  let override: string | null = null;
  const dClash = await findDriverClash(driver.id, load.id, rest);
  if (dClash) {
    if (why.length < 3) throw new RelayError("double_booked", `${driver.name} is already on ${dClash.loadNumber ?? "another load"} (${windowText(dClash.window)}). Add a reason to put them on this one anyway.`);
    override = why;
  }
  if (truck && !sameTruck) {
    const tClash = await findTruckClash(truck.id, load.id, rest, workspaceId);
    if (tClash) {
      if (why.length < 3) throw new RelayError("truck_busy", `${truck.name ?? "That truck"} is already on ${tClash.loadNumber ?? "another load"} (${windowText(tClash.window)}). Add a reason to use it anyway.`);
      override = why;
    }
  }
  if (truck && !sameTruck && h.trailerId) {
    const other = await prisma.trailer.findFirst({ where: { workspaceId, archivedAt: null, currentVehicleId: truck.id, id: { not: h.trailerId } }, select: { number: true } });
    if (other) throw new RelayError("trailer_busy", `${truck.name ?? "That truck"} already pulls ${other.number}. Unhook it first.`);
  }

  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    try {
      await claimLoad(tx, h.loadId, workspaceId, ["in_progress"], {});
      // A hook or a rescue puts the load on the next truck (a swap keeps its own).
      if (truck && !sameTruck) await tx.load.update({ where: { id: h.loadId }, data: { vehicleId: truck.id } });
    } catch (e) {
      if (e instanceof LoadMoved) throw new RelayError("not_relayable", e.message);
      throw e;
    }
    // The baton is taken once (must be acknowledged if it was disputed): a second tap, or another dispatcher, finds it already received.
    const taken = await tx.handoff.updateMany({ where: { id: h.id, state: "dropped" }, data: { state: "received" } });
    if (taken.count !== 1) throw new RelayError("not_receivable", "This handoff was already received.");
    const seq = h.outLegSeq + 1;
    const inPayEst = input.pay.kind === "flat" ? new Prisma.Decimal(input.pay.rate).toDecimalPlaces(2) : null;
    await tx.loadLeg.create({
      data: {
        workspaceId,
        loadId: h.loadId,
        seq,
        kind: "haul",
        status: "active",
        driverId: driver.id,
        driverName: driver.name,
        vehicleId: truck?.id ?? null,
        vehicleName: truck?.name ?? null,
        trailerId: h.trailerId,
        trailerNumber: h.trailerNumber,
        fromName: h.locationName,
        fromLat: h.locationLat,
        fromLng: h.locationLng,
        startedAt: now,
        payKind: input.pay.kind,
        payRate: new Prisma.Decimal(input.pay.rate),
        payEstimate: inPayEst
      }
    });
    // The new driver holds the load on the road; cpm/percent estimate settles on the closing remainder miles.
    await tx.assignment.create({
      data: { loadId: h.loadId, driverId: driver.id, payKind: input.pay.kind, payRate: new Prisma.Decimal(input.pay.rate), payEstimate: inPayEst, status: "in_progress", dispatchedBy: via === "dispatcher" ? senderNameOf(currentActor()) : null, respondedAt: now, driverResponse: { via, handoffId: h.id, at: now.toISOString() } }
    });
    // The incoming driver's phone gets the load (a bridged driver; nothing is queued for one the dispatcher answers for).
    await enqueueBridge(tx, { workspaceId, loadId: h.loadId, kind: "dispatch", driverId: driver.id, now });
    if (truck && !sameTruck && h.trailerId) {
      await tx.trailer.update({ where: { id: h.trailerId }, data: { currentVehicleId: truck.id, hookedAt: now, unhookedAt: null, dwellRateOverride: null, dwellDaysOverride: null, dwellWaived: false, dwellOverrideNote: null, dwellOverrideBy: null, dwellOverrideAt: null } });
      await tx.trailerMove.create({ data: { workspaceId, trailerId: h.trailerId, vehicleId: truck.id, kind: "hooked", at: now, lat: h.locationLat, lng: h.locationLng, byName: currentActor() } });
      await recordAudit({ entity: "trailer", entityId: h.trailerId, action: "trailer_hooked", summary: `${h.trailerNumber ?? "Trailer"} hooked to ${truck.name ?? "a truck"} at the relay handoff`, before: { Tractor: null }, after: { Tractor: truck.name }, workspaceId, at: now }, tx);
    }
    const receivedSource = via === "phone" ? "driver" : "dispatcher";
    const sealMatches = input.sealMatches ?? null;
    const final = {
      state: "received",
      inLegSeq: seq,
      inDriverId: driver.id,
      inDriverName: driver.name,
      tractorInId: truck?.id ?? null,
      tractorInName: truck?.name ?? null,
      receivedAt: now,
      receivedSource,
      sealMatches,
      // The condition the next driver found. What the outgoing driver said at the drop is kept in the notes, not overwritten.
      conditionOk: input.conditionOk ?? h.conditionOk,
      conditionNotes: [h.conditionNotes, (input.conditionNotes ?? "").trim() ? `Found on pickup: ${(input.conditionNotes ?? "").trim()}` : null].filter(Boolean).join(" | ") || null
    };
    const row = { ...h, ...final };
    const hash = sha(batonDigestText({ ...row, loadId: h.loadId }));
    const done = await tx.handoff.update({ where: { id: h.id }, data: { ...final, frozenAt: now, frozenSha256: hash } });
    await recordAssignmentEvent(tx, { workspaceId, loadId: h.loadId, loadNumber: load.loadNumber, kind: "received", driverId: driver.id, driverName: driver.name, reasonNote: override, via, at: now });
    await recordAudit(
      {
        entity: "assignment",
        action: "handoff_received",
        loadId: h.loadId,
        loadNumber: load.loadNumber,
        summary: `${driver.name} took the load at ${place(h)}${truck && !sameTruck ? ` in ${truck.name ?? "another truck"}` : ""}${override ? ", double-booked on purpose" : ""}`,
        reason: override,
        before: { Driver: null, Status: "Awaiting handoff" },
        after: { Driver: driver.name, Status: "On the road" },
        at: now, workspaceId
      },
      tx
    );
    return done;
  });
}

/**
 * The next driver, or dispatch, reports something wrong at the handoff (a broken seal, damage). The baton is frozen as found, custody does not transfer, and dispatch is alerted at the
 * highest level until it acknowledges. The outgoing driver is not blamed by this record: it says what was found, by whom, and when.
 */
export async function flagDiscrepancy(handoffId: string, input: { notes: string; raisedBy: "incoming_driver" | "dispatcher" }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const notes = (input.notes ?? "").trim();
  if (notes.length < 3) throw new RelayError("bad_discrepancy", "Say what was found: a few words.");
  const h = await prisma.handoff.findFirst({ where: { id: handoffId, workspaceId } });
  if (!h) throw new RelayError("handoff_not_found", "That handoff does not exist.");
  const load = await loadForRelay(h.loadId, workspaceId, allowed !== undefined ? allowed : await currentAllowed(workspaceId));
  if (!load) throw new RelayError("load_not_found", "That load does not exist.");
  if (h.state !== "dropped") throw new RelayError("not_receivable", h.state === "disputed" ? "A discrepancy is already reported on this handoff." : "This handoff was already received.");
  const by = input.raisedBy === "incoming_driver" ? "Incoming driver" : currentActor();
  return prisma.$transaction(async (tx) => {
    try {
      await claimLoad(tx, h.loadId, workspaceId, ["in_progress"], {});
    } catch (e) {
      if (e instanceof LoadMoved) throw new RelayError("not_relayable", e.message);
      throw e;
    }
    const flagged = { state: "disputed", discrepancyFlagged: true, discrepancyNotes: notes, discrepancyBy: by, discrepancyAt: now };
    const gone = await tx.handoff.updateMany({ where: { id: h.id, state: "dropped" }, data: flagged });
    if (gone.count !== 1) throw new RelayError("not_receivable", "A discrepancy is already reported on this handoff.");
    const hash = sha(batonDigestText({ ...h, ...flagged }));
    const done = await tx.handoff.update({ where: { id: h.id }, data: { frozenAt: now, frozenSha256: hash } });
    await recordAudit({ entity: "assignment", action: "handoff_disputed", loadId: h.loadId, loadNumber: load.loadNumber, summary: `Discrepancy at the handoff at ${place(h)}: ${notes}`, reason: by, before: { Handoff: "Awaiting handoff" }, after: { Handoff: "Disputed" }, at: now, workspaceId }, tx);
    return done;
  });
}

/** Dispatch says it has seen the discrepancy. The baton goes back to awaiting handoff, with the discrepancy and who acknowledged it kept on it, so the next driver can take custody. */
export async function acknowledgeDiscrepancy(handoffId: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const h = await prisma.handoff.findFirst({ where: { id: handoffId, workspaceId } });
  if (!h) throw new RelayError("handoff_not_found", "That handoff does not exist.");
  const load = await loadForRelay(h.loadId, workspaceId, allowed !== undefined ? allowed : await currentAllowed(workspaceId));
  if (!load) throw new RelayError("load_not_found", "That load does not exist.");
  if (h.state !== "disputed" || h.ackAt) throw new RelayError("not_receivable", "There is no unacknowledged discrepancy on this handoff.");
  return prisma.$transaction(async (tx) => {
    try {
      await claimLoad(tx, h.loadId, workspaceId, ["in_progress"], {});
    } catch (e) {
      if (e instanceof LoadMoved) throw new RelayError("not_relayable", e.message);
      throw e;
    }
    const gone = await tx.handoff.updateMany({ where: { id: h.id, state: "disputed", ackAt: null }, data: { state: "dropped", ackBy: currentActor(), ackAt: now } });
    if (gone.count !== 1) throw new RelayError("not_receivable", "That discrepancy was already acknowledged.");
    await recordAudit({ entity: "assignment", action: "handoff_acknowledged", loadId: h.loadId, loadNumber: load.loadNumber, summary: `Discrepancy acknowledged at the handoff at ${place(h)}`, before: { Handoff: "Disputed" }, after: { Handoff: "Awaiting handoff" }, at: now, workspaceId }, tx);
    return tx.handoff.findUniqueOrThrow({ where: { id: h.id } });
  });
}

/** A load's batons, oldest first. */
export const handoffsOfLoad = (loadId: string, workspaceId = currentWorkspaceId()) => prisma.handoff.findMany({ where: { loadId, workspaceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

/** A load's legs, oldest first. */
export const legsOfLoad = (loadId: string, workspaceId = currentWorkspaceId()) => prisma.loadLeg.findMany({ where: { loadId, workspaceId }, orderBy: { seq: "asc" } });

/** The batons waiting for a next driver, in the loads this person works (the scope fence of every other list), oldest drop first, with what the dispatch lane shows. */
export async function openHandoffs(workspaceId = currentWorkspaceId(), allowed?: Terminals, now = new Date()) {
  const al = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  const rows = await prisma.handoff.findMany({
    where: { workspaceId, state: { in: ["dropped", "disputed"] }, load: { deletedAt: null, ...inTerminal(al) } },
    include: { load: { select: { id: true, loadNumber: true, originAddress: true, destinationAddress: true } } },
    orderBy: { droppedAt: "asc" }
  });
  const legCounts = rows.length ? await prisma.loadLeg.groupBy({ by: ["loadId"], where: { workspaceId, loadId: { in: rows.map((r) => r.loadId) } }, _count: { _all: true } }) : [];
  const legs = new Map(legCounts.map((c) => [c.loadId, c._count._all]));
  return rows.map((h) => ({ ...h, waitedMinutes: waitMinutes(h.droppedAt, now), badge: relayBadge(legs.get(h.loadId) ?? h.outLegSeq, { state: h.state, locationName: h.locationName }) }));
}
export type OpenHandoff = Awaited<ReturnType<typeof openHandoffs>>[number];

/** For the alert feed: the open baton of each of these loads, if it has one. */
export async function openHandoffByLoad(loadIds: string[], workspaceId: string) {
  const out = new Map<string, { state: string; locationName: string | null; droppedAt: Date; discrepancyFlagged: boolean; ackAt: Date | null; outDriverName: string | null }>();
  if (loadIds.length === 0) return out;
  const rows = await prisma.handoff.findMany({ where: { workspaceId, loadId: { in: loadIds }, state: { in: ["dropped", "disputed"] } }, select: { loadId: true, state: true, locationName: true, droppedAt: true, discrepancyFlagged: true, ackAt: true, outDriverName: true } });
  for (const r of rows) out.set(r.loadId, r);
  return out;
}


/** Who can take a dropped load and in what: the best few drivers (the same list and notes as an assignment: a lapsed card blocks, being on another load is a note) and the trucks this person can use. */
export async function receiveOptions(loadId: string, workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const al = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(al) }, include: loadInclude });
  if (!l) return { drivers: [], trucks: [] as Array<{ id: string; name: string }> };
  const ranked = await rankDrivers(l, workspaceId, await currentTerminal(workspaceId), al);
  const vehicles = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, terminal: true }, orderBy: { name: "asc" }, take: 500 });
  return { drivers: pickerOptions(ranked.options), trucks: vehicles.filter((v) => inScope(al, v.terminal)).map((v) => ({ id: v.id, name: v.name ?? "Unnamed truck" })) };
}
