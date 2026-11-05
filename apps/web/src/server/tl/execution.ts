import { Prisma } from "@prisma/client";
import { loadStatusFor } from "@/lib/load-state";
import { prisma } from "@/lib/db";
import { dateTime } from "@/lib/desk-format";
import { EXPENSE_ITEMS, otherExpenseTotal, validateComplete, validateCorrection, validateExpenses, validateStart, type CompleteValues, type CorrectValues, type ExpenseInput, type ExpenseValues, type StartValues, type TripErrors } from "@/lib/trip";
import { recordAudit } from "./audit";
import { claimAssignment, claimLoad, LoadMoved } from "./claim";
import { num } from "./convert";
import { settlementOfLoad } from "./settlement";
import { tripHoursOf } from "./dispatch";
import { payEstimate, type PayKind } from "./projector";
import { rateConTotal } from "@/lib/pay";
import { currentWorkspaceId } from "./workspace";
import { stopClocksOf } from "./stop-clock";

/**
 * Entering a trip for a driver who is not entering it on the phone. It is the same record the phone writes: arrival and wait at each stop, the
 * seal, when it was delivered, proof of delivery (or why there is none), what the trip cost. Every entry is audited as made by the desk, so a
 * trip is never confused with one the driver recorded. The phone owns execution once the two are connected; this is the dispatcher's way to
 * keep the record true until then, and for a driver who texts a photo instead.
 */
export type TripResult = { ok: true } | { ok: false; error?: string; errors?: TripErrors };

const money = (n: number) => `$${n.toFixed(2)}`;

type ExtrasLoad = {
  expenseFuelActual: unknown;
  expenseTolls: unknown;
  expenseMisc: unknown;
  expenseItems: unknown;
  layoverPay: unknown;
  insuranceRiderFlat: unknown;
  revenueNote: string | null;
  pickupDeadheadMiles: unknown;
  loadedMiles: unknown;
  returnDeadheadMiles: unknown;
  quotedPickupDhMiles: unknown;
  quotedLoadedMiles: unknown;
  quotedReturnDhMiles: unknown;
  isBackhaul: boolean;
  tonuMiles: unknown;
};

const itemsOf = (raw: unknown): Record<string, number> => (raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, num(v as never)])) : {});

/**
 * What a trip's costs and figures change on the load, and how the audit says it. One place for the delivery and for a later correction, so they cannot drift: fuel, tolls, the other
 * costs (itemised, kept as items and as their total with "other"), layover pay, the rider, the revenue note, the miles actually driven (the quote's miles are kept once beside them)
 * and whether a load covered the way home. `data` is what to write, `before` and `after` the audit's lines for what changed, `changed` whether anything did.
 */
export function extrasPatch(load: ExtrasLoad, v: ExpenseInput) {
  const data: Prisma.LoadUncheckedUpdateInput = {};
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  const note = (label: string, was: string | null, now: string | null) => {
    before[label] = was;
    after[label] = now;
  };
  const wasItems = itemsOf(load.expenseItems);
  const wasOther = num(load.expenseMisc as never);
  const nowOther = otherExpenseTotal(v);
  let changed = false;

  if (num(load.expenseFuelActual as never) !== v.fuel) { data.expenseFuelActual = v.fuel; note("Fuel", money(num(load.expenseFuelActual as never)), money(v.fuel)); changed = true; }
  if (num(load.expenseTolls as never) !== v.tolls) { data.expenseTolls = v.tolls; note("Tolls", money(num(load.expenseTolls as never)), money(v.tolls)); changed = true; }
  if (v.items) {
    for (const i of EXPENSE_ITEMS) {
      const was = wasItems[i.key] ?? 0;
      const now = v.items[i.key] ?? 0;
      if (was !== now) { note(i.label, was > 0 ? money(was) : null, now > 0 ? money(now) : null); changed = true; }
    }
    data.expenseItems = Object.keys(v.items).length > 0 ? (v.items as Prisma.InputJsonValue) : Prisma.DbNull;
    data.expenseMisc = nowOther;
    if (wasOther !== nowOther && !EXPENSE_ITEMS.some((i) => (wasItems[i.key] ?? 0) !== (v.items?.[i.key] ?? 0))) { note("Other", money(wasOther), money(nowOther)); changed = true; }
    else if (wasOther !== nowOther) { changed = true; }
  } else if (wasOther !== v.misc) {
    data.expenseMisc = v.misc;
    note("Other", money(wasOther), money(v.misc));
    changed = true;
  }
  if (num(load.layoverPay as never) !== v.layover) { data.layoverPay = v.layover > 0 ? v.layover : null; note("Layover pay", money(num(load.layoverPay as never)), money(v.layover)); changed = true; }
  if (v.rider != null && num(load.insuranceRiderFlat as never) !== v.rider) { data.insuranceRiderFlat = v.rider > 0 ? v.rider : null; note("Insurance rider", money(num(load.insuranceRiderFlat as never)), money(v.rider)); changed = true; }
  if (v.revenueNote != null && v.revenueNote !== (load.revenueNote ?? "")) { data.revenueNote = v.revenueNote; note("Revenue note", load.revenueNote, v.revenueNote); changed = true; }
  if (v.miles) {
    const cur = { pickup: num(load.pickupDeadheadMiles as never), loaded: num(load.loadedMiles as never), home: num(load.returnDeadheadMiles as never) };
    const next = { pickup: v.miles.pickup ?? cur.pickup, loaded: v.miles.loaded ?? cur.loaded, home: v.miles.home ?? cur.home };
    if (next.pickup !== cur.pickup || next.loaded !== cur.loaded || next.home !== cur.home) {
      // The miles the load was quoted at are kept once, the way the phone does before it writes what was driven over them.
      if (load.quotedPickupDhMiles == null) data.quotedPickupDhMiles = cur.pickup;
      if (load.quotedLoadedMiles == null) data.quotedLoadedMiles = cur.loaded;
      if (load.quotedReturnDhMiles == null) data.quotedReturnDhMiles = cur.home;
      data.pickupDeadheadMiles = next.pickup;
      data.loadedMiles = next.loaded;
      data.returnDeadheadMiles = next.home;
      const m = (x: { pickup: number; loaded: number; home: number }) => `${x.pickup} · ${x.loaded} · ${x.home}`;
      note("Miles driven", m(cur), m(next));
      changed = true;
    }
  }
  if (v.tonuMiles != null && num(load.tonuMiles as never) !== v.tonuMiles) { data.tonuMiles = v.tonuMiles; note("Miles driven for the TONU", load.tonuMiles == null ? null : `${num(load.tonuMiles as never)}`, `${v.tonuMiles}`); changed = true; }
  if (v.backhaul != null && v.backhaul !== load.isBackhaul) { data.isBackhaul = v.backhaul; note("Way home", load.isBackhaul ? "A load covers it" : "Counted empty", v.backhaul ? "A load covers it" : "Counted empty"); changed = true; }
  return { data, before, after, changed };
}

async function loadFor(loadId: string, workspaceId: string) {
  return prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: { include: { driver: true } } } });
}

/** The driver picked up: they arrived at the first stop, waited, and sealed the trailer. The load is on the road. */
export async function startTrip(loadId: string, values: StartValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult> {
  // A time typed for a stop is the dock's time: read on the clock where the stop is (the zone the browser sent is not trusted).
  const clocks = await stopClocksOf(loadId, workspaceId);
  const check = validateStart({ ...values, zone: clocks[0]?.zone }, now.getTime());
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  const a = load.assignment;
  if (load.status !== "accepted" || !a || a.status !== "accepted") return { ok: false, error: "The driver has to have accepted the load first. Send it, then record their answer." };
  const pickup = load.stops[0];
  if (!pickup) return { ok: false, error: "This load has no stops." };

  try {
  await prisma.$transaction(async (tx) => {
    // From the state it was read in: a second press, or another tab, finds the load already on the road and changes nothing.
    await claimLoad(tx, load.id, workspaceId, ["accepted"], { status: "in_progress" });
    await claimAssignment(tx, load.id, ["accepted"], { status: "in_progress" });
    await tx.stop.update({ where: { id: pickup.id }, data: { arrivedAt: v.arrivedAt, waitMinutes: v.waitMinutes, sealNumber: v.seal } });
    await recordAudit(
      {
        entity: "load",
        action: "trip_started",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `${a.driver.name} picked up, entered by the desk: arrived ${dateTime(v.arrivedAt)}${v.waitMinutes != null ? `, waited ${v.waitMinutes} min` : ""}${v.seal ? `, seal ${v.seal}` : ""}`,
        before: { Status: "Accepted" },
        after: { Status: "On the road", Arrived: dateTime(v.arrivedAt), Waited: v.waitMinutes != null ? `${v.waitMinutes} min` : null, Seal: v.seal },
        at: now, workspaceId
      },
      tx
    );
  });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}

/**
 * Take the pickup back: it was entered against the wrong load, or before it happened. The load goes back to accepted (the driver still has it), and the pickup's arrival, wait and
 * seal are cleared. Only while nothing has been entered after the pickup. The reason is kept.
 */
export async function undoStartTrip(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the pickup is being taken back." };
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (load.status !== "in_progress") return { ok: false, error: "Only a load that is on the road can have its pickup taken back." };
  if (load.stops.slice(1).some((s) => s.arrivedAt != null)) return { ok: false, error: "A later stop has arrival times entered. Take those back first, or finish the trip." };
  const pickup = load.stops[0];
  if (!pickup || !load.assignment) return { ok: false, error: "This load has no pickup to take back." };
  try {
  await prisma.$transaction(async (tx) => {
    await claimLoad(tx, load.id, workspaceId, ["in_progress"], { status: loadStatusFor("accepted") });
    await claimAssignment(tx, load.id, ["in_progress"], { status: "accepted" });
    await tx.stop.update({ where: { id: pickup.id }, data: { arrivedAt: null, waitMinutes: null, sealNumber: null } });
    await recordAudit({ entity: "load", action: "trip_undone", loadId: load.id, loadNumber: load.loadNumber, summary: `Pickup taken back: ${load.assignment!.driver.name} has the load again, not yet on the road`, reason: why, before: { Status: "On the road", Arrived: pickup.arrivedAt ? dateTime(pickup.arrivedAt) : null }, after: { Status: "Accepted", Arrived: null }, at: now, workspaceId }, tx);
  });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}

/**
 * Take the delivery back: it was entered against the wrong load, or with the wrong times. The load is on the road again (its delivery time, proof-of-delivery answer and actual
 * revenue are cleared; the stops' arrival and wait times and the expenses stay, to be corrected). Not once the load has been invoiced or is on a driver statement: those carry what
 * was delivered. The reason is kept.
 */
export async function reopenDelivered(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the delivery is being taken back." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { assignment: { include: { driver: true } }, settlement: true } });
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (load.status !== "completed") return { ok: false, error: "Only a delivered load can have its delivery taken back." };
  if (load.paymentStatus) return { ok: false, error: "This load has been invoiced. Take the invoice back first." };
  if (load.settlement) return { ok: false, error: "This load is on a driver statement, so what was delivered is what the driver was paid on." };
  if (!load.assignment) return { ok: false, error: "This load has no driver, so there is no trip to reopen." };
  try {
  await prisma.$transaction(async (tx) => {
    // Not once an invoice or a statement has been made from it, even if that happened since this was read.
    await claimLoad(tx, load.id, workspaceId, ["completed"], { status: loadStatusFor("in_progress"), completedAt: null, actualRevenue: null, closedWithoutPod: null, podNote: null }, { paymentStatus: null, settlement: { is: null } });
    await tx.assignment.updateMany({ where: { loadId: load.id }, data: { status: "in_progress" } });
    await recordAudit({ entity: "load", action: "trip_reopened", loadId: load.id, loadNumber: load.loadNumber, summary: `Delivery taken back: ${load.assignment!.driver.name} is on the road again`, reason: why, before: { Status: "Delivered", Delivered: load.completedAt ? dateTime(load.completedAt) : null, ...(load.actualRevenue != null ? { "Linehaul paid": money(num(load.actualRevenue)) } : {}) }, after: { Status: "On the road", Delivered: null }, at: now, workspaceId }, tx);
  });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}

/**
 * The driver delivered. Arrival and wait are kept for each stop that has them; the delivery time closes the load; the proof of delivery is
 * either there (with a note on what and where) or its absence is explained; and what the trip cost is recorded. The rate confirmation's
 * rate becomes the load's actual revenue, as the phone does, and the waits add up to the dock wait the verdict reads.
 */
export async function completeTrip(loadId: string, values: CompleteValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult> {
  const clocks = await stopClocksOf(loadId, workspaceId);
  const check = validateComplete({ ...values, deliveredZone: clocks[clocks.length - 1]?.zone, stops: values.stops.map((s) => ({ ...s, zone: clocks.find((c) => c.id === s.id)?.zone })) }, now.getTime());
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (load.status !== "in_progress") return { ok: false, error: load.status === "completed" ? "This load is already delivered." : "A load has to be picked up before it can be delivered." };
  if (v.stops.some((s) => !load.stops.some((x) => x.id === s.id))) return { ok: false, error: "The stops on this load changed. Reload it and try again." };
  const pickupArrived = load.stops[0]?.arrivedAt ?? null;
  if (pickupArrived && v.deliveredAt < pickupArrived) return { ok: false, errors: { deliveredAt: "That is before the pickup. Check the date." } };

  const waits = load.stops.map((s) => {
    const typed = v.stops.find((x) => x.id === s.id);
    return typed?.waitMinutes ?? s.waitMinutes ?? 0;
  });
  const dockWait = waits.reduce((sum, w) => sum + w, 0);
  const a = load.assignment;
  const extras = extrasPatch(load, v.expenses);
  try {
  await prisma.$transaction(async (tx) => {
    for (const s of v.stops) {
      const had = load.stops.find((x) => x.id === s.id)!;
      // A blank seal keeps the one already recorded; a typed one is written at that stop (the table shows a seal column for every stop, so it can be entered at every stop).
      if (s.arrivedAt != null || s.waitMinutes != null || s.seal != null) await tx.stop.update({ where: { id: s.id }, data: { arrivedAt: s.arrivedAt ?? had.arrivedAt, waitMinutes: s.waitMinutes ?? had.waitMinutes, sealNumber: s.seal ?? had.sealNumber } });
    }
    await claimLoad(tx, load.id, workspaceId, ["in_progress"], {
        status: "completed",
        completedAt: v.deliveredAt,
        // What was actually paid when the broker paid a different linehaul (a short pay, an adjusted rate); otherwise the rate on the load, as the phone does.
        actualRevenue: v.actualRevenue ?? load.quotedRevenue,
        dockWaitMinutes: dockWait,
        closedWithoutPod: v.pod === "none",
        podNote: v.podNote,
        ...extras.data,
        // A delivery always writes these (the fresh trip had none): blank is none.
        expenseFuelActual: v.expenses.fuel,
        expenseTolls: v.expenses.tolls,
        expenseMisc: otherExpenseTotal(v.expenses),
        layoverPay: v.expenses.layover > 0 ? v.expenses.layover : null
    });
    if (a) await claimAssignment(tx, load.id, ["accepted", "in_progress"], { status: "completed" });
    const spent = v.expenses.fuel + v.expenses.tolls + otherExpenseTotal(v.expenses);
    const quoted = num(load.quotedRevenue);
    const seals = v.stops.filter((s) => s.seal != null).map((s) => `${load.stops.find((x) => x.id === s.id)?.stopSequence ?? "?"}: ${s.seal}`);
    const differs = v.actualRevenue != null && !new Prisma.Decimal(v.actualRevenue).equals(new Prisma.Decimal(quoted));
    await recordAudit(
      {
        entity: "load",
        action: "delivered",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Delivered ${dateTime(v.deliveredAt)}, entered by the desk${v.pod === "none" ? ", no proof of delivery" : ""}${spent > 0 ? `, ${money(spent)} of expenses` : ""}${differs ? `, linehaul paid ${money(v.actualRevenue!)} (the load said ${money(quoted)})` : ""}`,
        reason: v.pod === "none" ? v.podNote : null,
        before: { Status: "On the road" },
        after: { Status: "Delivered", Delivered: dateTime(v.deliveredAt), "Proof of delivery": v.pod === "received" ? (v.podNote ?? "Received") : "None", "Dock wait": `${dockWait} min`, Expenses: spent > 0 ? money(spent) : null, ...(differs ? { "Linehaul paid": money(v.actualRevenue!) } : {}), ...(seals.length > 0 ? { Seals: seals.join(", ") } : {}), ...(extras.after["Miles driven"] ? { "Miles driven": extras.after["Miles driven"] } : {}) },
        at: now, workspaceId
      },
      tx
    );
  });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}

/**
 * What the trip cost and drove, entered or corrected: fuel, tolls, the itemised costs, layover pay, the rider, the revenue note, the miles actually driven and the way home. A load that is
 * on the road, delivered, or a TONU can be changed (a TONU still cost the truck a trip); a cancelled one has no trip.
 */
export async function saveExpenses(loadId: string, values: ExpenseValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult & { changed?: boolean }> {
  const check = validateExpenses(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (!["in_progress", "completed", "tonu"].includes(load.status)) return { ok: false, error: "A load has to be on the road, delivered or a TONU to have expenses." };
  const patch = extrasPatch(load, v);
  if (!patch.changed) return { ok: true, changed: false };
  // The loaded miles are what a per-mile driver was paid on: once the load is on a final statement they stay as they were paid (the other figures do not change the pay).
  if (patch.data.loadedMiles !== undefined) {
    const settled = await settlementOfLoad(load.id);
    if (settled) return { ok: false, error: `This load is on driver statement ${settled.number}, so its loaded miles are what the driver was paid on. Void the statement first to correct them.` };
  }
  const was = num(load.expenseFuelActual) + num(load.expenseTolls) + num(load.expenseMisc);
  const now2 = v.fuel + v.tolls + otherExpenseTotal(v);
  const labels = Object.keys(patch.after);
  try {
  await prisma.$transaction(async (tx) => {
    // Written only if the load is still as it was read: two people correcting the same trip do not overwrite each other.
    const claimed = await tx.load.updateMany({ where: { id: load.id, workspaceId, deletedAt: null, status: load.status, updatedAt: load.updatedAt }, data: patch.data as Prisma.LoadUncheckedUpdateManyInput });
    if (claimed.count !== 1) throw new LoadMoved("This load was just changed by someone else. Reload it and try again.");
    // The driver's pay estimate follows the miles actually driven: a per-mile estimate on the loaded miles, an hourly one on the trip's hours.
    const a = load.assignment;
    if (a && (patch.data.loadedMiles !== undefined || patch.data.pickupDeadheadMiles !== undefined || patch.data.returnDeadheadMiles !== undefined || patch.data.isBackhaul !== undefined) && (a.payKind === "cpm" || a.payKind === "hourly")) {
      const now3 = { pickupDeadheadMiles: patch.data.pickupDeadheadMiles ?? load.pickupDeadheadMiles, loadedMiles: patch.data.loadedMiles ?? load.loadedMiles, returnDeadheadMiles: patch.data.returnDeadheadMiles ?? load.returnDeadheadMiles, isBackhaul: (patch.data.isBackhaul as boolean | undefined) ?? load.isBackhaul, estimatedLoadedHours: load.estimatedLoadedHours };
      const refreshed = payEstimate({ kind: a.payKind as PayKind, rate: num(a.payRate) }, num(now3.loadedMiles as never), a.payKind === "hourly" ? tripHoursOf(now3) : null, rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge)));
      await tx.assignment.update({ where: { loadId: load.id }, data: { payEstimate: refreshed } });
    }
    await recordAudit(
      {
        entity: "load",
        action: "expenses_changed",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: was !== now2 ? `Expenses ${money(was)} to ${money(now2)}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}` : `Trip figures changed: ${labels.join(", ")}`,
        before: patch.before,
        after: patch.after,
        at: now, workspaceId
      },
      tx
    );
  });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, changed: true };
}

/**
 * Correct what was entered at the stops after the fact: when the driver arrived, how long they waited, the seal, and (for a rate confirmation that differs from the truck's profile) this
 * load's own detention rate and free time. The dock wait the verdict and the detention read is the sum of the stops' waits, so it is worked out again. A load that is on the road or
 * delivered can be corrected; not once an invoice is made from it (it carries what was billed), unless only a seal changed. The reason is kept.
 */
export async function correctTrip(loadId: string, values: CorrectValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TripResult & { changed?: boolean }> {
  const clocks = await stopClocksOf(loadId, workspaceId);
  const check = validateCorrection({ ...values, stops: values.stops.map((s) => ({ ...s, zone: clocks.find((c) => c.id === s.id)?.zone })) }, now.getTime());
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (!["in_progress", "completed"].includes(load.status)) return { ok: false, error: "Only a load that is on the road, or delivered, has a trip to correct." };
  if (v.stops.some((s) => !load.stops.some((x) => x.id === s.id))) return { ok: false, error: "The stops on this load changed. Reload it and try again." };

  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  const edits: Array<{ id: string; data: Prisma.StopUncheckedUpdateInput }> = [];
  let timesChanged = false;
  for (const s of v.stops) {
    const had = load.stops.find((x) => x.id === s.id)!;
    const data: Prisma.StopUncheckedUpdateInput = {};
    const tag = `Stop ${had.stopSequence}`;
    if ((s.arrivedAt?.getTime() ?? null) !== (had.arrivedAt?.getTime() ?? null)) { data.arrivedAt = s.arrivedAt; before[`${tag} arrived`] = had.arrivedAt ? dateTime(had.arrivedAt) : null; after[`${tag} arrived`] = s.arrivedAt ? dateTime(s.arrivedAt) : null; timesChanged = true; }
    if (s.waitMinutes !== had.waitMinutes) { data.waitMinutes = s.waitMinutes; before[`${tag} waited`] = had.waitMinutes != null ? `${had.waitMinutes} min` : null; after[`${tag} waited`] = s.waitMinutes != null ? `${s.waitMinutes} min` : null; timesChanged = true; }
    if (s.seal !== had.sealNumber) { data.sealNumber = s.seal; before[`${tag} seal`] = had.sealNumber; after[`${tag} seal`] = s.seal; }
    if (Object.keys(data).length > 0) edits.push({ id: s.id, data });
  }
  const loadData: Prisma.LoadUncheckedUpdateInput = {};
  if (v.detentionRate != null && v.detentionRate !== num(load.snapshotDetentionRate)) { loadData.snapshotDetentionRate = v.detentionRate; before["Detention rate"] = load.snapshotDetentionRate == null ? null : `${money(num(load.snapshotDetentionRate))}/hr`; after["Detention rate"] = `${money(v.detentionRate)}/hr`; timesChanged = true; }
  if (v.detentionGraceMinutes != null && v.detentionGraceMinutes !== load.snapshotFreeGraceMinutes) { loadData.snapshotFreeGraceMinutes = v.detentionGraceMinutes; before["Free time"] = load.snapshotFreeGraceMinutes == null ? null : `${load.snapshotFreeGraceMinutes} min`; after["Free time"] = `${v.detentionGraceMinutes} min`; timesChanged = true; }
  if (edits.length === 0 && Object.keys(loadData).length === 0) return { ok: true, changed: false };
  if (timesChanged && load.paymentStatus) return { ok: false, error: "This load has been invoiced, and the invoice carries the waits it was billed on. Take the invoice back first, or correct only the seals." };

  const waits = load.stops.map((s) => edits.find((e) => e.id === s.id)?.data.waitMinutes ?? s.waitMinutes ?? 0);
  loadData.dockWaitMinutes = waits.reduce<number>((sum, w) => sum + num(w as never), 0);
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.load.updateMany({ where: { id: load.id, workspaceId, deletedAt: null, status: load.status, updatedAt: load.updatedAt, ...(timesChanged ? { paymentStatus: null } : {}) }, data: loadData as Prisma.LoadUncheckedUpdateManyInput });
      if (claimed.count !== 1) throw new LoadMoved("This load was just changed by someone else. Reload it and try again.");
      for (const e of edits) await tx.stop.update({ where: { id: e.id }, data: e.data });
      await recordAudit({ entity: "load", action: "trip_corrected", loadId: load.id, loadNumber: load.loadNumber, summary: `Trip corrected: ${Object.keys(after).join(", ")}`, reason: v.reason, before, after, at: now, workspaceId }, tx);
    });
  } catch (e) {
    if (e instanceof LoadMoved) return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, changed: true };
}
