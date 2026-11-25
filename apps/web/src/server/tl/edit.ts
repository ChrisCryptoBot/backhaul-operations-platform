import { randomUUID } from "node:crypto";
import { loadStatusFor } from "@/lib/load-state";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { dateTime } from "@/lib/desk-format";
import { parseBilledExtras, type BilledExtra } from "@/lib/invoicing";
import { planStopChanges, STOP_CHANGE_FEE_LABEL, validateLoadEdit, type LoadEditValues } from "@/lib/load-edit";
import { loadWindow } from "@/lib/schedule";
import { saveStopCoordinates } from "@/server/geo/persist";
import { measureQuote } from "@/server/geo/measure";
import { cityState } from "@/lib/city-state";
import { recordAudit } from "./audit";
import { payEstimate, type PayKind } from "./projector";
import { rateConTotal } from "@/lib/pay";
import { freezeLoadSnapshot } from "./snapshot";
import { num, numOrNull } from "./convert";
import { resolveOrCreateCustomer } from "./customers";
import { findDriverClash, findTruckClash, windowText } from "./dispatch";
import { truckFit } from "@/lib/load-fit";
import { roleOfStop } from "@/lib/stop-role";
import { truckLimits } from "./quote";
import { duplicateMessage, findTwinLoad } from "./twins";
import type { Terminals } from "@/lib/scope";
import { enqueueForLoad } from "@/server/bridge/outbox";
import { recordAssignmentEvent } from "./assignment-events";
import { LoadMoved } from "./claim";
import { lockWorkspace } from "./plan";
import { onStatement } from "./settlement";
import { allowedFor } from "./scope";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { stopClocksOf } from "./stop-clock";
import { workspaceTimezone } from "./zone";
import { senderNameOf } from "@/lib/driver-messages";
import { currentActor } from "./identity";

/**
 * Change what a booked load says. Anything can be corrected while the load is open; on an in-progress load, visited stops stay locked
 * (preserving their exact sequence numbers and driver progress) while unvisited stops after the last visited stop can be edited, added,
 * removed, or reordered with a reason (reconsignment, appointment change, stop added/dropped) and an optional fee. A change to a stop's
 * place or time that a driver already has is a new ask: the driver confirms again, and a driver who would then be on two loads at once blocks it.
 */
export type EditResult = { ok: true; changed: boolean; note: string | null } | { ok: false; errors?: Record<string, string>; error?: string };

const CLOSED = ["cancelled", "tonu"];
const text = (v: unknown) => (v == null || v === "" ? null : String(v));
const yesNo = (v: boolean | null | undefined) => (v === true ? "Yes" : "No");
const decText = (v: unknown) => (v == null ? null : new Prisma.Decimal(String(v)).toString());

export async function saveLoadDetails(loadId: string, values: LoadEditValues, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<EditResult> {
  const scope = await allowedFor(workspaceId, allowed);
  // The times typed for a stop are the dock's: read on the clock where each stop is, worked out here and not taken from the browser.
  const clocks = await stopClocksOf(loadId, workspaceId);
  const carrier = await workspaceTimezone(workspaceId);
  const check = validateLoadEdit({ ...values, stops: values.stops.map((s) => ({ ...s, zone: clocks.find((c) => c.id === s.id)?.zone ?? carrier })) }, carrier);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  type TxOutcome =
    | { ok: false; errors?: Record<string, string>; error?: string }
    | {
        ok: true;
        changed: boolean;
        note: string | null;
        needsGeo?: boolean;
        remeasure?: boolean;
        orderedStops?: Array<{ address: string; role: "pickup" | "delivery" }>;
        canUpdateMiles?: boolean;
      };
  const result: TxOutcome = await (async (): Promise<TxOutcome> => {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockWorkspace(tx, workspaceId);
        const load = await tx.load.findFirst({
          where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) },
          include: {
            stops: { orderBy: { stopSequence: "asc" } },
            assignment: { include: { driver: true } },
            vehicle: true,
            settlement: true,
            settlementLegs: { select: { id: true }, take: 1 }
          }
        });
        if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
        if (CLOSED.includes(load.status)) return { ok: false, error: "A cancelled load, or one closed as a TONU, cannot be edited." };
        // The form was opened on one version of the load. If it has changed since, saving this form would overwrite their change: refuse.
        if (values.version != null && values.version !== "" && values.version !== String(load.updatedAt.getTime())) {
          return { ok: false, error: "This load changed since you opened it. If a note at the top says your details were kept, press Start over there; otherwise close this and open it again. Then make your change." };
        }
        // An invoice carries the load number, the customer, the PO and the terms it was billed under: they stay as billed.
        if (load.paymentStatus) {
          const held: string[] = [];
          if ((v.loadNumber ?? null) !== (load.loadNumber ?? null)) held.push("load number");
          if ((v.brokerName ?? null) !== (load.brokerName ?? null)) held.push("customer");
          if ((v.poNumber ?? null) !== (load.poNumber ?? null)) held.push("PO number");
          if ((v.payTermsDays ?? null) !== (load.payTermsDays ?? null)) held.push("pay terms");
          if (held.length > 0) {
            return {
              ok: false,
              error: `This load has been invoiced, so its ${held.join(", ")} ${held.length === 1 ? "is" : "are"} what the invoice carries and stay${held.length === 1 ? "s" : ""} as billed. Take the invoice back first to change ${held.length === 1 ? "it" : "them"}.`
            };
          }
        }
        const resolvedCustomer = v.brokerName
          ? v.brokerName !== load.brokerName || !load.customerId
            ? await resolveOrCreateCustomer(tx, workspaceId, { name: v.brokerName, mcNumber: v.brokerMc, phone: v.brokerPhone, email: v.brokerEmail, payTermsDays: v.payTermsDays })
            : { id: load.customerId, name: load.brokerName }
          : null;
        // Another load on the desk with this load or rate-con number from this customer is the same load.
        const numberChanged = v.loadNumber != null && v.loadNumber !== load.loadNumber;
        const rateConChanged = v.rateConNumber != null && v.rateConNumber !== load.rateConNumber;
        if (numberChanged || rateConChanged) {
          const twin = await findTwinLoad(
            workspaceId,
            numberChanged ? v.loadNumber : null,
            v.brokerName ?? load.brokerName,
            load.id,
            tx,
            resolvedCustomer?.id ?? load.customerId,
            rateConChanged ? v.rateConNumber : null
          );
          if (twin) {
            const errField = !numberChanged && rateConChanged ? "rateConNumber" : "loadNumber";
            return { ok: false, errors: { [errField]: `${duplicateMessage(twin)} Use another number.` } };
          }
        }

        const existingPlan = load.stops.map((s) => ({
          id: s.id,
          stopSequence: s.stopSequence,
          role: roleOfStop(s),
          address: s.addressString,
          earliest: s.timeWindowEarliest,
          latest: s.timeWindowLatest,
          visited: s.arrivedAt != null
        }));
        const stopPlan = planStopChanges(
          existingPlan,
          v.stops.map((s) => ({ id: s.id, role: s.role, address: s.address, earliest: s.earliest, latest: s.latest }))
        );
        if (!stopPlan.ok) return { ok: false, error: stopPlan.error };
        const scheduleChanged = stopPlan.scheduleChanged;

        if (scheduleChanged) {
          if (load.status === "completed") {
            return { ok: false, error: "A completed load cannot change where or when its stops are. Its other details can still be corrected." };
          }
          if (load.status === "in_progress" && !v.stopChangeReason) {
            return { ok: false, error: "This load has started: pick a reason (reconsignment, appointment change, stop added or dropped) to change unvisited stops." };
          }
          if (!["draft", "accepted", "in_progress"].includes(load.status)) {
            return { ok: false, error: "A load that has started cannot change where or when its stops are. Its other details can still be corrected." };
          }
        }
        if (v.stopChangeFee != null && v.stopChangeFee > 0 && load.status === "in_progress" && !v.stopChangeReason) {
          return { ok: false, error: "This load has started: pick a reason before adding a stop or reconsignment fee." };
        }

        const old = new Map(load.stops.map((s) => [s.id, s]));

        // The money and the truck. Once a load is billed or paid out on a statement, these are what was billed and paid, so they stay.
        const deal = v.deal ?? null;
        const usd = (n: number | null) => (n == null || n === 0 ? null : `$${n.toFixed(2)}`);
        const miles = (n: number) => (n === 0 ? null : String(n));
        const was = { rate: num(load.quotedRevenue), fsc: numOrNull(load.fuelSurcharge), loaded: num(load.loadedMiles), pick: num(load.pickupDeadheadMiles), home: num(load.returnDeadheadMiles) };
        const wasPaid = numOrNull(load.actualRevenue);
        const followsRate = deal != null && load.status === "completed" && deal.rate !== was.rate && (wasPaid == null || wasPaid === was.rate);
        const truckChanged = deal != null && deal.vehicleId !== (load.vehicleId ?? null);
        const milesChanged = deal != null && (deal.loadedMiles !== was.loaded || deal.emptyToPickup !== was.pick || deal.emptyHome !== was.home);
        const moneyChanged = deal != null && (deal.rate !== was.rate || (deal.fuelSurcharge ?? 0) !== (was.fsc ?? 0) || milesChanged);
        const specs = { weightLbs: v.weightLbs, lengthFt: v.lengthFt, widthFt: v.widthFt, heightIn: v.heightIn, hazmatClass: v.hazmat, requiresLiftgate: v.liftgate, requiresRamp: v.ramp, requiresPalletJack: v.palletJack };
        const specsChanged =
          v.weightLbs !== load.weightLbs ||
          v.lengthFt !== numOrNull(load.lengthFt as never) ||
          v.widthFt !== numOrNull(load.widthFt as never) ||
          v.heightIn !== numOrNull(load.loadHeightIn as never) ||
          v.hazmat !== load.hazmatClass ||
          v.liftgate !== (load.requiresLiftgate === true) ||
          v.ramp !== (load.requiresRamp === true) ||
          v.palletJack !== (load.requiresPalletJack === true);
        let truck: { id: string; name: string } | null = null;
        if (deal && (truckChanged || moneyChanged)) {
          if (load.paymentStatus) return { ok: false, error: "This load has been invoiced, so its truck, rate and miles are what was billed and stay as they are." };
          if (onStatement(load)) return { ok: false, error: "This load is on a driver statement, so its truck, rate and miles are what the driver was paid on and stay as they are." };
        }
        if (deal && truckChanged) {
          if (!["draft", "accepted"].includes(load.status)) return { ok: false, error: "A load that has started keeps its truck. Its rate and miles can still be corrected." };
          if (deal.vehicleId == null) return { ok: false, error: "Pick the truck that has this load." };
          const found = await tx.vehicle.findFirst({ where: { id: deal.vehicleId, workspaceId, archivedAt: null }, include: { costProfile: true } });
          if (!found) return { ok: false, error: "That truck is not available." };
          const fit = truckFit(specs, truckLimits(found));
          if (fit.blocker) return { ok: false, error: `${found.name} cannot take this load. ${fit.blocker}` };
          const busy = await findTruckClash(found.id, load.id, loadWindow(v.stops.map((s) => ({ timeWindowEarliest: s.earliest, timeWindowLatest: s.latest }))), workspaceId, tx);
          if (busy) return { ok: false, error: `${found.name} is already on ${busy.loadNumber ?? "another load"} (${windowText(busy.window)}). Pick another truck, or move that load first.` };
          if (!found.costProfile) return { ok: false, error: `${found.name} has no cost profile yet. Set it up on the truck's page, then move the load.` };
          truck = { id: found.id, name: found.name ?? "Unnamed truck" };
        } else if (specsChanged && load.vehicle) {
          const fit = truckFit(specs, truckLimits(load.vehicle));
          if (fit.blocker) return { ok: false, error: `${load.vehicle.name ?? "This truck"} cannot take this load. ${fit.blocker}` };
        }

        const existingExtras = parseBilledExtras(load.billedExtras);
        const addedExtra: BilledExtra | null =
          v.stopChangeFee != null && v.stopChangeFee > 0
            ? {
                id: randomUUID(),
                label: STOP_CHANGE_FEE_LABEL[v.stopChangeReason ?? "reconsignment"],
                amount: new Prisma.Decimal(v.stopChangeFee).toDecimalPlaces(2).toNumber(),
                reason: v.stopChangeReason ?? "reconsignment",
                at: now.toISOString(),
                kind: "stop_off"
              }
            : null;
        const nextExtras = addedExtra ? [...existingExtras, addedExtra] : existingExtras;

        // What changed, as label, before and after, for the audit entry.
        const rows: Array<[string, string | null, string | null]> = [
          ["Customer", text(load.brokerName), resolvedCustomer?.name ?? v.brokerName],
          ["MC number", text(load.brokerMcNumber), v.brokerMc],
          ["Customer phone", text(load.brokerPhone), v.brokerPhone],
          ["Customer email", text(load.brokerEmail), v.brokerEmail],
          ["Load number", text(load.loadNumber), v.loadNumber],
          ["Rate con number", text(load.rateConNumber), v.rateConNumber],
          ["PRO number", text(load.proNumber), v.proNumber],
          ["PO number", text(load.poNumber), v.poNumber],
          ["BOL number", text(load.bolNumber), v.bolNumber],
          ["Trailer", text(load.trailerType), v.trailer],
          ["Commodity", text(load.commodity), v.commodity],
          ["Pieces", text(load.pieceCount), text(v.pieceCount)],
          ["Pallets", text(load.palletCount), text(v.palletCount)],
          ["Weight (lb)", text(load.weightLbs), text(v.weightLbs)],
          ["Length (ft)", text(numOrNull(load.lengthFt as never)), text(v.lengthFt)],
          ["Width (ft)", text(numOrNull(load.widthFt as never)), text(v.widthFt)],
          ["Height (in)", text(numOrNull(load.loadHeightIn as never)), text(v.heightIn)],
          ["Reefer set (°F)", decText(load.reeferSetTempF), decText(v.reeferSetTempF)],
          ["Reefer min (°F)", decText(load.reeferMinF), decText(v.reeferMinF)],
          ["Reefer max (°F)", decText(load.reeferMaxF), decText(v.reeferMaxF)],
          ["Reefer mode", text(load.reeferMode), v.reeferMode],
          ["Hazmat class", text(load.hazmatClass), v.hazmat],
          ["Hazmat UN #", text(load.hazmatUnNumber), v.hazmatUnNumber],
          ["Hazmat packing group", text(load.hazmatPackingGroup), v.hazmatPackingGroup],
          ["Hazmat emergency phone", text(load.hazmatEmergencyPhone), v.hazmatEmergencyPhone],
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
        if (v.stopChangeReason && scheduleChanged) {
          rows.push(["Stop change reason", null, STOP_CHANGE_FEE_LABEL[v.stopChangeReason]]);
        }
        if (addedExtra) {
          rows.push(["Stop change fee", null, `$${addedExtra.amount.toFixed(2)}`]);
        }
        const refsText = (x: unknown) => (Array.isArray(x) && x.length > 0 ? (x as unknown[]).map(String).join(", ") : null);
        v.stops.forEach((s, i) => {
          const planned = stopPlan.planned[i]!;
          const n = planned.stopSequence;
          if (planned.isNew) {
            rows.push([`Stop ${n} added`, null, `${s.role === "pickup" ? "Pickup" : "Delivery"} · ${s.address}`]);
            return;
          }
          const o = old.get(s.id)!;
          if (o.stopSequence !== planned.stopSequence) {
            rows.push([`Stop ${s.address} sequence`, String(o.stopSequence), String(planned.stopSequence)]);
          }
          rows.push(
            [`Stop ${n} address`, text(o.addressString), s.address],
            [`Stop ${n} facility`, text(o.facilityName), s.facility],
            [`Stop ${n} opens`, o.timeWindowEarliest ? dateTime(o.timeWindowEarliest) : null, s.earliest ? dateTime(s.earliest) : null],
            [`Stop ${n} closes`, o.timeWindowLatest ? dateTime(o.timeWindowLatest) : null, s.latest ? dateTime(s.latest) : null],
            [`Stop ${n} references`, refsText(o.referenceNumbers), s.refs.length > 0 ? s.refs.join(", ") : null],
            [`Stop ${n} contact`, text(o.contactName), s.contactName],
            [`Stop ${n} phone`, text(o.contactPhone), s.contactPhone],
            [`Stop ${n} notes`, text(o.stopNotes), s.notes]
          );
        });
        for (const rid of stopPlan.removedIds) {
          const ex = old.get(rid);
          if (ex) rows.push([`Stop ${ex.stopSequence} removed`, `${roleOfStop(ex)} · ${ex.addressString}`, null]);
        }
        const changed = rows.filter(([, a, b]) => (a ?? null) !== (b ?? null));
        if (changed.length === 0 && !stopPlan.structureChanged && resolvedCustomer?.id === load.customerId) {
          return { ok: true, changed: false, note: null };
        }

        const a = load.assignment && load.assignment.status !== "declined" ? load.assignment : null;
        if (scheduleChanged && a) {
          const win = loadWindow(v.stops.map((s) => ({ timeWindowEarliest: s.earliest, timeWindowLatest: s.latest })));
          const clash = await findDriverClash(a.driverId, load.id, win, tx);
          if (clash) return { ok: false, error: `${a.driver.name} would be on ${clash.loadNumber ?? "another load"} at the new times. Change the times, or take the driver off this load first.` };
        }
        const total = deal ? rateConTotal(deal.rate, deal.fuelSurcharge ?? 0) : 0;
        const newEstimate = a && deal && moneyChanged && (a.payKind === "cpm" || a.payKind === "percent") ? payEstimate({ kind: a.payKind as PayKind, rate: num(a.payRate) }, deal.loadedMiles, null, total) : null;
        const payChanged = newEstimate != null && num(newEstimate) !== num(a!.payEstimate);
        const reconfirm = (scheduleChanged || payChanged) && a != null && (a.status === "dispatched" || a.status === "accepted");

        const pickups = v.stops.filter((s) => s.role === "pickup").flatMap((s) => s.refs);
        const deliveries = v.stops.filter((s) => s.role === "delivery").flatMap((s) => s.refs);
        const first = v.stops[0];
        const last = v.stops[v.stops.length - 1];
        const baseMs = now.getTime();
        const nextUpdatedAt = new Date(baseMs > load.updatedAt.getTime() ? baseMs : load.updatedAt.getTime() + 1);
        const deliveryCount = v.stops.filter((s) => s.role === "delivery").length;
        const claimed = await tx.load.updateMany({
          where: { id: load.id, workspaceId, deletedAt: null, updatedAt: load.updatedAt, ...inTerminal(scope) },
          data: {
            brokerName: resolvedCustomer?.name ?? v.brokerName,
            customerId: resolvedCustomer?.id ?? null,
            brokerMcNumber: v.brokerMc,
            brokerPhone: v.brokerPhone,
            brokerEmail: v.brokerEmail,
            loadNumber: v.loadNumber,
            rateConNumber: v.rateConNumber,
            proNumber: v.proNumber,
            poNumber: v.poNumber,
            bolNumber: v.bolNumber,
            trailerType: v.trailer,
            commodity: v.commodity,
            pieceCount: v.pieceCount,
            palletCount: v.palletCount,
            weightLbs: v.weightLbs,
            lengthFt: v.lengthFt,
            widthFt: v.widthFt,
            loadHeightIn: v.heightIn,
            reeferSetTempF: v.reeferSetTempF,
            reeferMinF: v.reeferMinF,
            reeferMaxF: v.reeferMaxF,
            reeferMode: v.reeferMode,
            hazmatClass: v.hazmat,
            hazmatUnNumber: v.hazmatUnNumber,
            hazmatPackingGroup: v.hazmatPackingGroup,
            hazmatEmergencyPhone: v.hazmatEmergencyPhone,
            requiresLiftgate: v.liftgate,
            requiresRamp: v.ramp,
            requiresPalletJack: v.palletJack,
            payTermsDays: v.payTermsDays,
            notes: v.notes,
            pickupNumbers: pickups,
            deliveryNumbers: deliveries,
            stopsCount: deliveryCount > 0 ? deliveryCount : v.stops.length,
            originAddress: first ? (cityState(first.address) ?? first.address) : load.originAddress,
            destinationAddress: last ? (cityState(last.address) ?? last.address) : load.destinationAddress,
            scheduledDate: first?.earliest ?? load.scheduledDate,
            updatedAt: nextUpdatedAt,
            ...(addedExtra ? { billedExtras: nextExtras as unknown as Prisma.InputJsonValue } : {}),
            ...(reconfirm && load.status !== loadStatusFor("dispatched") ? { status: loadStatusFor("dispatched") } : {}),
            ...(deal
              ? {
                  vehicleId: truckChanged ? deal.vehicleId : load.vehicleId,
                  quotedRevenue: deal.rate,
                  ...(followsRate ? { actualRevenue: deal.rate } : {}),
                  fuelSurcharge: deal.fuelSurcharge,
                  loadedMiles: deal.loadedMiles,
                  pickupDeadheadMiles: deal.emptyToPickup,
                  returnDeadheadMiles: deal.emptyHome,
                  ...(deal.loadedMiles !== was.loaded ? { estimatedLoadedHours: null } : {})
                }
              : {})
          }
        });
        if (claimed.count !== 1) throw new LoadMoved("This load changed since you opened it. If a note at the top says your details were kept, press Start over there; otherwise close this and open it again. Then make your change.");
        if ((v.brokerEmail ?? null) !== (load.brokerEmail ?? null) || (v.brokerPhone ?? null) !== (load.brokerPhone ?? null)) {
          await tx.invoice.updateMany({
            where: { workspaceId, kind: "invoice", status: "open", paidTotal: 0, loads: { some: { loadId: load.id } } },
            data: { billToEmail: v.brokerEmail, billToPhone: v.brokerPhone }
          });
        }
        if (stopPlan.removedIds.length > 0) {
          await tx.stop.deleteMany({ where: { id: { in: stopPlan.removedIds }, loadId: load.id } });
        }
        for (let i = 0; i < v.stops.length; i++) {
          const s = v.stops[i]!;
          const p = stopPlan.planned[i]!;
          if (p.isNew) {
            await tx.stop.create({
              data: {
                loadId: load.id,
                stopSequence: p.stopSequence,
                stopType: s.role,
                stopRole: s.role,
                addressString: s.address,
                facilityName: s.facility,
                timeWindowEarliest: s.earliest,
                timeWindowLatest: s.latest,
                referenceNumbers: s.refs,
                contactName: s.contactName,
                contactPhone: s.contactPhone,
                stopNotes: s.notes
              }
            });
          } else {
            const moved = old.get(s.id)!.addressString !== s.address;
            await tx.stop.update({
              where: { id: s.id },
              data: {
                stopSequence: p.stopSequence,
                stopType: s.role,
                stopRole: s.role,
                addressString: s.address,
                ...(moved ? { lat: null, lng: null } : {}),
                facilityName: s.facility,
                timeWindowEarliest: s.earliest,
                timeWindowLatest: s.latest,
                referenceNumbers: s.refs,
                contactName: s.contactName,
                contactPhone: s.contactPhone,
                stopNotes: s.notes
              }
            });
          }
        }
        if (reconfirm) {
          await tx.assignment.update({
            where: { loadId: load.id },
            data: { status: "dispatched", dispatchedAt: now, dispatchedBy: senderNameOf(currentActor()), respondedAt: null, driverResponse: Prisma.JsonNull, assignmentVersion: { increment: 1 } }
          });
          await recordAssignmentEvent(tx, {
            workspaceId,
            loadId: load.id,
            loadNumber: v.loadNumber ?? load.loadNumber,
            kind: "reoffered",
            driverId: a!.driverId,
            driverName: a!.driver.name,
            reasonNote: payChanged && !scheduleChanged ? "Pay changed" : "Details changed",
            assignmentVersion: a!.assignmentVersion + 1,
            at: now
          });
        }
        await enqueueForLoad(tx, { workspaceId, loadId: load.id, kind: reconfirm ? "dispatch" : "update", now });
        if (payChanged) await tx.assignment.update({ where: { loadId: load.id }, data: { payEstimate: newEstimate! } });
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
            reason: v.stopChangeReason ? STOP_CHANGE_FEE_LABEL[v.stopChangeReason] : undefined,
            summary: `Details changed: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}${reconfirm ? `. ${a!.driver.name} has to confirm again` : ""}`,
            before,
            after,
            at: now,
            workspaceId
          },
          tx
        );
        return {
          ok: true,
          changed: true,
          needsGeo: true,
          remeasure: stopPlan.routeChanged,
          orderedStops: v.stops.map((s) => ({ address: s.address, role: s.role })),
          canUpdateMiles: !load.paymentStatus && !onStatement(load) && !(deal && deal.loadedMiles !== was.loaded),
          note: reconfirm ? `${a!.driver.name} has the load, so they have to confirm ${payChanged && !scheduleChanged ? "what it pays now" : "the change"}.` : null
        };
      });
    } catch (e) {
      if (e instanceof LoadMoved) return { ok: false, error: e.message };
      throw e;
    }
  })();
  if (!result.ok) return result;
  if (result.needsGeo) await saveStopCoordinates(loadId);
  if (result.remeasure && result.orderedStops && result.orderedStops.length >= 2) {
    try {
      const measured = await measureQuote({ stops: result.orderedStops, homes: [] });
      if (measured.ok) {
        await prisma.load.update({
          where: { id: loadId },
          data: {
            estimatedLoadedHours: measured.loadedHours,
            ...(result.canUpdateMiles ? { loadedMiles: measured.loadedMiles } : {})
          }
        });
      }
    } catch {
      // Soft fail: route re-measurement never rolls back a saved stop edit.
    }
  }
  return { ok: true, changed: result.changed, note: result.note };
}
