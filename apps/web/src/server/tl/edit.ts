import { loadStatusFor } from "@/lib/load-state";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { dateTime } from "@/lib/desk-format";
import { validateLoadEdit, type LoadEditValues } from "@/lib/load-edit";
import { loadWindow } from "@/lib/schedule";
import { saveStopCoordinates } from "@/server/geo/persist";
import { cityState } from "@/lib/city-state";
import { recordAudit } from "./audit";
import { payEstimate, type PayKind } from "./projector";
import { rateConTotal } from "@/lib/pay";
import { freezeLoadSnapshot } from "./snapshot";
import { num, numOrNull } from "./convert";
import { findDriverClash, findTruckClash, windowText } from "./dispatch";
import { truckFit } from "@/lib/load-fit";
import { truckLimits } from "./quote";
import { duplicateMessage, findTwinLoad } from "./twins";
import { enqueueForLoad } from "@/server/bridge/outbox";
import { currentWorkspaceId } from "./workspace";

/**
 * Change what a booked load says. Anything can be corrected while the load is open; once it is on the road or delivered its details (who it is
 * for, its numbers, notes) can still be fixed but not where or when its stops are. A change to a stop's place or time that a driver already
 * has is a new ask: the driver confirms again, and a driver who would then be on two loads at once blocks it. The audit entry lists only what
 * changed, with before and after.
 */
export type EditResult = { ok: true; changed: boolean; note: string | null } | { ok: false; errors?: Record<string, string>; error?: string };

const CLOSED = ["cancelled", "tonu"];
const text = (v: unknown) => (v == null || v === "" ? null : String(v));
const yesNo = (v: boolean | null | undefined) => (v === true ? "Yes" : "No");

export async function saveLoadDetails(loadId: string, values: LoadEditValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<EditResult> {
  const check = validateLoadEdit(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: { include: { driver: true } }, vehicle: true, settlement: true } });
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (CLOSED.includes(load.status)) return { ok: false, error: "A cancelled load, or one closed as a TONU, cannot be edited." };
  // The form was opened on one version of the load. If it has changed since (someone sent it, accepted it, edited it), saving this form would overwrite their change with what
  // was on screen: refuse, and say to reload.
  if (values.version != null && values.version !== "" && values.version !== String(load.updatedAt.getTime())) return { ok: false, error: "This load changed since you opened it. If a note at the top says your details were kept, press Start over there; otherwise close this and open it again. Then make your change." };
  // An invoice carries the load number, the customer, the PO and the terms it was billed under: they stay as billed.
  if (load.paymentStatus) {
    const held: string[] = [];
    if ((v.loadNumber ?? null) !== (load.loadNumber ?? null)) held.push("load number");
    if ((v.brokerName ?? null) !== (load.brokerName ?? null)) held.push("customer");
    if ((v.poNumber ?? null) !== (load.poNumber ?? null)) held.push("PO number");
    if ((v.payTermsDays ?? null) !== (load.payTermsDays ?? null)) held.push("pay terms");
    if (held.length > 0) return { ok: false, error: `This load has been invoiced, so its ${held.join(", ")} ${held.length === 1 ? "is" : "are"} what the invoice carries and stay${held.length === 1 ? "s" : ""} as billed. Take the invoice back first to change ${held.length === 1 ? "it" : "them"}.` };
  }
  // Another load on the desk with this number from this customer is the same load.
  if (v.loadNumber && v.loadNumber !== load.loadNumber) {
    const twin = await findTwinLoad(workspaceId, v.loadNumber, v.brokerName ?? load.brokerName, load.id);
    if (twin) return { ok: false, errors: { loadNumber: `${duplicateMessage(twin)} Use another number.` } };
  }
  if (v.stops.length !== load.stops.length || v.stops.some((s) => !load.stops.some((x) => x.id === s.id))) return { ok: false, error: "The stops on this load changed since you opened it. Reload it and try again." };

  const old = new Map(load.stops.map((s) => [s.id, s]));
  // The form holds whole minutes, so two times in the same minute are the same time: seconds on a stored window are not a change.
  const minute = (d: Date | null) => (d ? new Prisma.Decimal(d.getTime()).div(60_000).floor().toNumber() : null);
  const same = (a: Date | null, b: Date | null) => minute(a) === minute(b);
  const scheduleChanged = v.stops.some((s) => {
    const o = old.get(s.id)!;
    return o.addressString !== s.address || !same(o.timeWindowEarliest, s.earliest) || !same(o.timeWindowLatest, s.latest);
  });
  if (scheduleChanged && !["draft", "accepted"].includes(load.status)) return { ok: false, error: "A load that has started cannot change where or when its stops are. Its other details can still be corrected." };

  // The money and the truck. Once a load is billed or paid out on a statement, these are what was billed and paid, so they stay.
  const deal = v.deal ?? null;
  const usd = (n: number | null) => (n == null || n === 0 ? null : `$${n.toFixed(2)}`);
  const miles = (n: number) => (n === 0 ? null : String(n));
  const was = { rate: num(load.quotedRevenue), fsc: numOrNull(load.fuelSurcharge), loaded: num(load.loadedMiles), pick: num(load.pickupDeadheadMiles), home: num(load.returnDeadheadMiles) };
  // A delivered load's revenue was copied from the rate when it was delivered, and a correction to the rate has to reach it, or the KPI keeps reading the old rate. But only when it
  // was that copy: a load delivered at a different "linehaul actually paid" (a short pay) keeps what was paid, and a change to its notes or phone number touches no money at all.
  const wasPaid = numOrNull(load.actualRevenue);
  const followsRate = deal != null && load.status === "completed" && deal.rate !== was.rate && (wasPaid == null || wasPaid === was.rate);
  const truckChanged = deal != null && deal.vehicleId !== (load.vehicleId ?? null);
  const milesChanged = deal != null && (deal.loadedMiles !== was.loaded || deal.emptyToPickup !== was.pick || deal.emptyHome !== was.home);
  const moneyChanged = deal != null && (deal.rate !== was.rate || (deal.fuelSurcharge ?? 0) !== (was.fsc ?? 0) || milesChanged);
  let truck: { id: string; name: string } | null = null;
  if (deal && (truckChanged || moneyChanged)) {
    if (load.paymentStatus) return { ok: false, error: "This load has been invoiced, so its truck, rate and miles are what was billed and stay as they are." };
    if (load.settlement) return { ok: false, error: "This load is on a driver statement, so its truck, rate and miles are what the driver was paid on and stay as they are." };
  }
  if (deal && truckChanged) {
    if (!["draft", "accepted"].includes(load.status)) return { ok: false, error: "A load that has started keeps its truck. Its rate and miles can still be corrected." };
    if (deal.vehicleId == null) return { ok: false, error: "Pick the truck that has this load." };
    const found = await prisma.vehicle.findFirst({ where: { id: deal.vehicleId, workspaceId, archivedAt: null }, include: { costProfile: true } });
    if (!found) return { ok: false, error: "That truck is not available." };
    // The truck has to be able to take the load (weight, size, equipment) and not be on another load at the same time: the Quote checks both, and moving a load to a truck must too.
    const specs = { weightLbs: v.weightLbs, lengthFt: v.lengthFt, widthFt: v.widthFt, heightIn: v.heightIn, hazmatClass: v.hazmat, requiresLiftgate: v.liftgate, requiresRamp: v.ramp, requiresPalletJack: v.palletJack };
    const fit = truckFit(specs, truckLimits(found));
    if (fit.blocker) return { ok: false, error: `${found.name} cannot take this load. ${fit.blocker}` };
    const busy = await findTruckClash(found.id, load.id, loadWindow(v.stops.map((s) => ({ timeWindowEarliest: s.earliest, timeWindowLatest: s.latest }))), workspaceId);
    if (busy) return { ok: false, error: `${found.name} is already on ${busy.loadNumber ?? "another load"} (${windowText(busy.window)}). Pick another truck, or move that load first.` };
    if (!found.costProfile) return { ok: false, error: `${found.name} has no cost profile yet. Set it up on the truck's page, then move the load.` };
    truck = { id: found.id, name: found.name ?? "Unnamed truck" };
  }

  // What changed, as label, before and after, for the audit entry.
  const rows: Array<[string, string | null, string | null]> = [
    ["Customer", text(load.brokerName), v.brokerName],
    ["MC number", text(load.brokerMcNumber), v.brokerMc],
    ["Customer phone", text(load.brokerPhone), v.brokerPhone],
    ["Customer email", text(load.brokerEmail), v.brokerEmail],
    ["Load number", text(load.loadNumber), v.loadNumber],
    ["PO number", text(load.poNumber), v.poNumber],
    ["Trailer", text(load.trailerType), v.trailer],
    ["Weight (lb)", text(load.weightLbs), text(v.weightLbs)],
    ["Length (ft)", text(numOrNull(load.lengthFt as never)), text(v.lengthFt)],
    ["Width (ft)", text(numOrNull(load.widthFt as never)), text(v.widthFt)],
    ["Height (in)", text(numOrNull(load.loadHeightIn as never)), text(v.heightIn)],
    ["Hazmat class", text(load.hazmatClass), v.hazmat],
    ["Liftgate needed", yesNo(load.requiresLiftgate), yesNo(v.liftgate)],
    ["Ramp needed", yesNo(load.requiresRamp), yesNo(v.ramp)],
    ["Pallet jack needed", yesNo(load.requiresPalletJack), yesNo(v.palletJack)],
    ["Pay terms (days)", text(load.payTermsDays), text(v.payTermsDays)],
    ["Notes", text(load.notes), v.notes]
  ];
  if (deal) {
    rows.push(
      ["Truck", load.vehicle?.name ?? null, truckChanged ? (truck?.name ?? null) : (load.vehicle?.name ?? null)],
      ["Rate", usd(was.rate), usd(deal.rate)],
      ...(followsRate ? ([["Linehaul paid", usd(wasPaid ?? was.rate), usd(deal.rate)]] as Array<[string, string | null, string | null]>) : []),
      ["Fuel surcharge", usd(was.fsc), usd(deal.fuelSurcharge)],
      ["Loaded miles", miles(was.loaded), miles(deal.loadedMiles)],
      ["Empty miles to the pickup", miles(was.pick), miles(deal.emptyToPickup)],
      ["Empty miles home", miles(was.home), miles(deal.emptyHome)]
    );
  }
  v.stops.forEach((s, i) => {
    const o = old.get(s.id)!;
    const n = i + 1;
    const refs = (x: unknown) => (Array.isArray(x) && x.length > 0 ? (x as unknown[]).map(String).join(", ") : null);
    rows.push(
      [`Stop ${n} address`, text(o.addressString), s.address],
      [`Stop ${n} facility`, text(o.facilityName), s.facility],
      [`Stop ${n} opens`, o.timeWindowEarliest ? dateTime(o.timeWindowEarliest) : null, s.earliest ? dateTime(s.earliest) : null],
      [`Stop ${n} closes`, o.timeWindowLatest ? dateTime(o.timeWindowLatest) : null, s.latest ? dateTime(s.latest) : null],
      [`Stop ${n} references`, refs(o.referenceNumbers), s.refs.length > 0 ? s.refs.join(", ") : null],
      [`Stop ${n} contact`, text(o.contactName), s.contactName],
      [`Stop ${n} phone`, text(o.contactPhone), s.contactPhone],
      [`Stop ${n} notes`, text(o.stopNotes), s.notes]
    );
  });
  const changed = rows.filter(([, a, b]) => (a ?? null) !== (b ?? null));
  if (changed.length === 0) return { ok: true, changed: false, note: null };

  const a = load.assignment && load.assignment.status !== "declined" ? load.assignment : null;
  if (scheduleChanged && a) {
    const win = loadWindow(v.stops.map((s) => ({ timeWindowEarliest: s.earliest, timeWindowLatest: s.latest })));
    const clash = await findDriverClash(a.driverId, load.id, win);
    if (clash) return { ok: false, error: `${a.driver.name} would be on ${clash.loadNumber ?? "another load"} at the new times. Change the times, or take the driver off this load first.` };
  }
  // A per-mile or percent pay is dollars the driver was told, so a change to the rate or the miles changes what they are owed.
  const total = deal ? rateConTotal(deal.rate, deal.fuelSurcharge ?? 0) : 0;
  const newEstimate = a && deal && moneyChanged && (a.payKind === "cpm" || a.payKind === "percent") ? payEstimate({ kind: a.payKind as PayKind, rate: num(a.payRate) }, deal.loadedMiles, null, total) : null;
  const payChanged = newEstimate != null && num(newEstimate) !== num(a!.payEstimate);
  const reconfirm = (scheduleChanged || payChanged) && a != null && (a.status === "dispatched" || a.status === "accepted");

  const pickups = v.stops.filter((s) => (old.get(s.id)!.stopRole ?? old.get(s.id)!.stopType) === "pickup").flatMap((s) => s.refs);
  const deliveries = v.stops.filter((s) => (old.get(s.id)!.stopRole ?? old.get(s.id)!.stopType) === "delivery").flatMap((s) => s.refs);
  const first = v.stops[0];
  const last = v.stops[v.stops.length - 1];
  await prisma.$transaction(async (tx) => {
    await tx.load.update({
      where: { id: load.id },
      data: {
        brokerName: v.brokerName,
        brokerMcNumber: v.brokerMc,
        brokerPhone: v.brokerPhone,
        brokerEmail: v.brokerEmail,
        loadNumber: v.loadNumber,
        poNumber: v.poNumber,
        trailerType: v.trailer,
        weightLbs: v.weightLbs,
        lengthFt: v.lengthFt,
        widthFt: v.widthFt,
        loadHeightIn: v.heightIn,
        hazmatClass: v.hazmat,
        requiresLiftgate: v.liftgate,
        requiresRamp: v.ramp,
        requiresPalletJack: v.palletJack,
        payTermsDays: v.payTermsDays,
        notes: v.notes,
        pickupNumbers: pickups,
        deliveryNumbers: deliveries,
        originAddress: first ? (cityState(first.address) ?? first.address) : load.originAddress,
        destinationAddress: last ? (cityState(last.address) ?? last.address) : load.destinationAddress,
        scheduledDate: first?.earliest ?? load.scheduledDate,
        ...(deal
          ? {
              vehicleId: truckChanged ? deal.vehicleId : load.vehicleId,
              quotedRevenue: deal.rate,
              ...(followsRate ? { actualRevenue: deal.rate } : {}),
              fuelSurcharge: deal.fuelSurcharge,
              loadedMiles: deal.loadedMiles,
              pickupDeadheadMiles: deal.emptyToPickup,
              returnDeadheadMiles: deal.emptyHome,
              // Hours measured for the old loaded miles no longer describe the new ones: the desk falls back to its flat 50 mph.
              ...(deal.loadedMiles !== was.loaded ? { estimatedLoadedHours: null } : {})
            }
          : {})
      }
    });
    for (const s of v.stops) {
      // A stop that moved has no coordinates until it is looked up again.
      const moved = old.get(s.id)!.addressString !== s.address;
      await tx.stop.update({ where: { id: s.id }, data: { addressString: s.address, ...(moved ? { lat: null, lng: null } : {}), facilityName: s.facility, timeWindowEarliest: s.earliest, timeWindowLatest: s.latest, referenceNumbers: s.refs, contactName: s.contactName, contactPhone: s.contactPhone, stopNotes: s.notes } });
    }
    if (reconfirm) {
      await tx.assignment.update({
        where: { loadId: load.id },
        data: { status: "dispatched", dispatchedAt: now, respondedAt: null, driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 } }
      });
      // The driver has to say yes again, so the load is no longer accepted (src/lib/load-state.ts: a sent assignment goes with a draft load).
      if (load.status !== loadStatusFor("dispatched")) await tx.load.update({ where: { id: load.id }, data: { status: loadStatusFor("dispatched") } });
    }
    // The driver's phone: a change they have to confirm again is a re-offer; any other change to a load that is on their phone reaches them as an update (the driver link).
    await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: reconfirm ? "dispatch" : "update", now });
    if (payChanged) await tx.assignment.update({ where: { loadId: load.id }, data: { payEstimate: newEstimate! } });
    // A load that has not started carries the cost floor of the truck and the miles it was booked with: refresh it when either changed.
    if (deal && (truckChanged || moneyChanged) && ["draft", "accepted"].includes(load.status)) await freezeLoadSnapshot(tx, load.id, { labour: load.assignment != null, refresh: truckChanged });
    const names = changed.map(([label]) => label);
    const before: AuditSnapshot = Object.fromEntries(changed.map(([label, b]) => [label, b]));
    const after: AuditSnapshot = Object.fromEntries(changed.map(([label, , b]) => [label, b]));
    await recordAudit(
      {
        entity: "load",
        action: "load_edited",
        loadId: load.id,
        loadNumber: v.loadNumber ?? load.loadNumber,
        summary: `Details changed: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}${reconfirm ? `. ${a!.driver.name} has to confirm again` : ""}`,
        before,
        after,
        at: now, workspaceId
      },
      tx
    );
  });
  await saveStopCoordinates(load.id);
  return { ok: true, changed: true, note: reconfirm ? `${a!.driver.name} has the load, so they have to confirm ${payChanged && !scheduleChanged ? "what it pays now" : "the change"}.` : null };
}
