import { prisma } from "@/lib/db";
import { dateTime } from "@/lib/desk-format";
import { validateComplete, validateExpenses, validateStart, type CompleteValues, type ExpenseValues, type StartValues, type TripErrors } from "@/lib/trip";
import { recordAudit } from "./audit";
import { num } from "./convert";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Entering a trip for a driver who is not entering it on the phone. It is the same record the phone writes: arrival and wait at each stop, the
 * seal, when it was delivered, proof of delivery (or why there is none), what the trip cost. Every entry is audited as made by the desk, so a
 * trip is never confused with one the driver recorded. The phone owns execution once the two are connected; this is the dispatcher's way to
 * keep the record true until then, and for a driver who texts a photo instead.
 */
export type TripResult = { ok: true } | { ok: false; error?: string; errors?: TripErrors };

const money = (n: number) => `$${n.toFixed(2)}`;

async function loadFor(loadId: string, workspaceId: string) {
  return prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: { include: { driver: true } } } });
}

/** The driver picked up: they arrived at the first stop, waited, and sealed the trailer. The load is on the road. */
export async function startTrip(loadId: string, values: StartValues, now = new Date(), workspaceId = DEMO_WORKSPACE_ID): Promise<TripResult> {
  const check = validateStart(values, now.getTime());
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  const a = load.assignment;
  if (load.status !== "accepted" || !a || a.status !== "accepted") return { ok: false, error: "The driver has to have accepted the load first. Send it, then record their answer." };
  const pickup = load.stops[0];
  if (!pickup) return { ok: false, error: "This load has no stops." };

  await prisma.$transaction(async (tx) => {
    await tx.stop.update({ where: { id: pickup.id }, data: { arrivedAt: v.arrivedAt, waitMinutes: v.waitMinutes, sealNumber: v.seal } });
    await tx.load.update({ where: { id: load.id }, data: { status: "in_progress" } });
    await tx.assignment.update({ where: { loadId: load.id }, data: { status: "in_progress" } });
    await recordAudit(
      {
        entity: "load",
        action: "trip_started",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `${a.driver.name} picked up, entered by the desk: arrived ${dateTime(v.arrivedAt)}${v.waitMinutes != null ? `, waited ${v.waitMinutes} min` : ""}${v.seal ? `, seal ${v.seal}` : ""}`,
        before: { Status: "Accepted" },
        after: { Status: "On the road", Arrived: dateTime(v.arrivedAt), Waited: v.waitMinutes != null ? `${v.waitMinutes} min` : null, Seal: v.seal },
        at: now
      },
      tx
    );
  });
  return { ok: true };
}

/**
 * The driver delivered. Arrival and wait are kept for each stop that has them; the delivery time closes the load; the proof of delivery is
 * either there (with a note on what and where) or its absence is explained; and what the trip cost is recorded. The rate confirmation's
 * rate becomes the load's actual revenue, as the phone does, and the waits add up to the dock wait the verdict reads.
 */
export async function completeTrip(loadId: string, values: CompleteValues, now = new Date(), workspaceId = DEMO_WORKSPACE_ID): Promise<TripResult> {
  const check = validateComplete(values, now.getTime());
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
  await prisma.$transaction(async (tx) => {
    for (const s of v.stops) {
      const had = load.stops.find((x) => x.id === s.id)!;
      if (s.arrivedAt != null || s.waitMinutes != null) await tx.stop.update({ where: { id: s.id }, data: { arrivedAt: s.arrivedAt ?? had.arrivedAt, waitMinutes: s.waitMinutes ?? had.waitMinutes } });
    }
    await tx.load.update({
      where: { id: load.id },
      data: {
        status: "completed",
        completedAt: v.deliveredAt,
        actualRevenue: load.quotedRevenue,
        dockWaitMinutes: dockWait,
        closedWithoutPod: v.pod === "none",
        podNote: v.podNote,
        expenseFuelActual: v.expenses.fuel,
        expenseTolls: v.expenses.tolls,
        expenseMisc: v.expenses.misc
      }
    });
    if (a) await tx.assignment.update({ where: { loadId: load.id }, data: { status: "completed" } });
    const spent = v.expenses.fuel + v.expenses.tolls + v.expenses.misc;
    await recordAudit(
      {
        entity: "load",
        action: "delivered",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Delivered ${dateTime(v.deliveredAt)}, entered by the desk${v.pod === "none" ? ", no proof of delivery" : ""}${spent > 0 ? `, ${money(spent)} of expenses` : ""}`,
        reason: v.pod === "none" ? v.podNote : null,
        before: { Status: "On the road" },
        after: { Status: "Delivered", Delivered: dateTime(v.deliveredAt), "Proof of delivery": v.pod === "received" ? (v.podNote ?? "Received") : "None", "Dock wait": `${dockWait} min`, Expenses: spent > 0 ? money(spent) : null },
        at: now
      },
      tx
    );
  });
  return { ok: true };
}

/** What the trip cost, entered or corrected. A load that is on the road or delivered can be changed; a cancelled one has no trip. */
export async function saveExpenses(loadId: string, values: ExpenseValues, now = new Date(), workspaceId = DEMO_WORKSPACE_ID): Promise<TripResult & { changed?: boolean }> {
  const check = validateExpenses(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await loadFor(loadId, workspaceId);
  if (!load || load.status === "quote") return { ok: false, error: "That load does not exist." };
  if (!["in_progress", "completed"].includes(load.status)) return { ok: false, error: "A load has to be on the road, or delivered, to have expenses." };
  const was = { fuel: num(load.expenseFuelActual), tolls: num(load.expenseTolls), misc: num(load.expenseMisc) };
  if (was.fuel === v.fuel && was.tolls === v.tolls && was.misc === v.misc) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: load.id }, data: { expenseFuelActual: v.fuel, expenseTolls: v.tolls, expenseMisc: v.misc } });
    await recordAudit(
      {
        entity: "load",
        action: "expenses_changed",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Expenses ${money(was.fuel + was.tolls + was.misc)} to ${money(v.fuel + v.tolls + v.misc)}`,
        before: { Fuel: money(was.fuel), Tolls: money(was.tolls), Other: money(was.misc) },
        after: { Fuel: money(v.fuel), Tolls: money(v.tolls), Other: money(v.misc) },
        at: now
      },
      tx
    );
  });
  return { ok: true, changed: true };
}
