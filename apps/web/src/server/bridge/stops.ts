import { prisma } from "@/lib/db";
import { dateTime } from "@/lib/desk-format";
import { nearestPlace } from "@/lib/gazetteer/place-index";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { wholeOf } from "./core";
import type { BridgeTransport, StopEventRow } from "./transport";

/**
 * What the driver recorded at each stop of a carrier's load, taken into the desk (sync plan Step 2). The phone sends stop events through its outbox (bridge.send_stop_event, the
 * phone project's supabase/migrations/20261122000100_bridge_stop_events.sql); this reads them in order and writes the stop's arrival, wait and seal, or a check call.
 *
 * Who owns a stop's times (Stop.arrivedSource): a dispatcher's entry is the desk's and a phone never overwrites it; the phone fills what is blank and replaces only its own
 * earlier values. A phone value that differs from the desk's is shown as a flag on the load, never applied. Detention reads the stop's times, so it now runs on the driver's
 * real arrival. A check call never becomes a truck position (no VehiclePing): it is what the driver sent, when they tapped.
 */

const ACTOR = "Driver's phone";

/** A stop's times as the desk holds them. */
export type HeldStop = { arrivedAt: Date | null; waitMinutes: number | null; sealNumber: string | null; arrivedSource: string | null };

/** The stop's times are the desk's: a dispatcher set them, or they were there before the source was kept (read as the desk's). */
export const deskOwned = (s: HeldStop): boolean => s.arrivedSource === "desk" || (s.arrivedSource == null && (s.arrivedAt != null || s.waitMinutes != null || s.sealNumber != null));

export type StopChange = {
  /** What to write on the stop (only the fields the event changes), or null for nothing. */
  data: { arrivedAt?: Date | null; waitMinutes?: number; sealNumber?: string; arrivedSource?: "phone" } | null;
  /** What the phone said that the desk kept its own value over, in words, or null. */
  clash: string | null;
};

const sameMinute = (a: Date, b: Date) => {
  const d = a.getTime() - b.getTime();
  return d > -60_000 && d < 60_000;
};

/**
 * What one stop event changes on a stop. Pure. `arrived` sets the arrival; `arrival_undone` takes back an arrival the phone set (never the desk's); `loaded` carries the wait the
 * phone measured and the seal; `emptied` the wait. A field that is blank, or the phone's own, is written; one the desk set is kept, and a different phone value is a clash.
 */
export function stopChange(e: Pick<StopEventRow, "kind" | "at" | "wait_minutes" | "seal">, s: HeldStop): StopChange {
  const desk = deskOwned(s);
  const data: NonNullable<StopChange["data"]> = {};
  const clashes: string[] = [];
  const at = new Date(e.at);
  if (e.kind === "arrived") {
    if (s.arrivedAt == null || !desk) data.arrivedAt = at;
    else if (!sameMinute(s.arrivedAt, at)) clashes.push(`arrived ${dateTime(at)} (the desk has ${dateTime(s.arrivedAt)})`);
  } else if (e.kind === "arrival_undone") {
    if (!desk && s.arrivedAt != null) data.arrivedAt = null;
  } else if (e.kind === "loaded" || e.kind === "emptied") {
    if (e.wait_minutes != null) {
      if (s.waitMinutes == null || !desk) data.waitMinutes = e.wait_minutes;
      else if (s.waitMinutes !== e.wait_minutes) clashes.push(`waited ${e.wait_minutes} min (the desk has ${s.waitMinutes} min)`);
    }
    if (e.kind === "loaded" && e.seal) {
      if (s.sealNumber == null || !desk) data.sealNumber = e.seal;
      else if (s.sealNumber !== e.seal) clashes.push(`seal ${e.seal} (the desk has ${s.sealNumber})`);
    }
  }
  const changed = Object.keys(data).length > 0;
  // A stop the desk had not touched becomes the phone's once the phone writes on it; a desk-owned stop stays the desk's (the phone only filled a blank).
  if (changed && !desk) data.arrivedSource = "phone";
  return { data: changed ? data : null, clash: clashes.length > 0 ? clashes.join("; ") : null };
}

/** The words for a stop event, in the activity trail. */
const EVENT_WORDS: Record<string, string> = { arrived: "Arrived", arrival_undone: "Arrival taken back", loaded: "Loaded and left", emptied: "Unloaded and left" };

/** Where a check call was sent from, in words: the nearest town when there is one within 60 miles, else the position. */
export function checkCallPlace(lat: number, lng: number): string {
  const near = nearestPlace(lat, lng);
  const pos = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  if (!near) return pos;
  return near.miles < 1 ? `${near.label} (${pos})` : `${near.miles.toFixed(0)} mi from ${near.label} (${pos})`;
}

export type StopPullResult = { read: number; applied: number; checkCalls: number; flagged: number; ignored: number; cursor: number };

/**
 * Take the phones' stop events into the desk, in order, at least once and idempotent (writing a stop's time again changes nothing; a check call already logged is not logged
 * twice). An event from a phone that does not hold the load on this desk is ignored, never guessed at. The cursor moves past what was read.
 */
export async function pullStopEvents(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<StopPullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true, bridgeStopCursor: true } });
  const res: StopPullResult = { read: 0, applied: 0, checkCalls: 0, flagged: 0, ignored: 0, cursor: wholeOf(ws?.bridgeStopCursor) };
  if (!ws?.bridgeOrgId) return res;
  const events = await transport.stopEventsSince(ws.bridgeOrgId, wholeOf(ws.bridgeStopCursor), opts.limit ?? 200);
  res.read = events.length;
  for (const e of events) {
    const load = e.source_load_id
      ? await prisma.load.findFirst({
          where: { id: e.source_load_id, workspaceId, deletedAt: null },
          select: { id: true, loadNumber: true, vehicleId: true, trailerId: true, paymentStatus: true, settlement: { select: { id: true } }, assignment: { select: { status: true, driver: { select: { phoneUserId: true, name: true } } } }, stops: { orderBy: { stopSequence: "asc" }, select: { id: true, stopSequence: true, arrivedAt: true, waitMinutes: true, sealNumber: true, arrivedSource: true } } }
        })
      : null;
    const a = load?.assignment;
    if (!load || !a || a.driver.phoneUserId !== e.driver_sub || !["accepted", "in_progress", "completed"].includes(a.status)) {
      res.ignored += 1;
      continue;
    }
    const at = new Date(e.at);
    if (e.kind === "check_call") {
      if (e.lat == null || e.lng == null) {
        res.ignored += 1;
        continue;
      }
      const already = await prisma.checkCall.findFirst({ where: { workspaceId, loadId: load.id, at, loggedBy: ACTOR }, select: { id: true } });
      if (!already) {
        await prisma.checkCall.create({ data: { workspaceId, loadId: load.id, vehicleId: load.vehicleId, trailerId: load.trailerId, at, place: checkCallPlace(e.lat, e.lng), note: `${a.driver.name} sent their location from the phone.`, loggedBy: ACTOR } });
      }
      res.checkCalls += 1;
      continue;
    }
    // The phone numbers stops 1..n in the desk's own order.
    const stop = e.stop_seq != null ? load.stops[e.stop_seq - 1] : undefined;
    if (!stop) {
      res.ignored += 1;
      continue;
    }
    const where = `stop ${e.stop_seq}`;
    if (load.paymentStatus || load.settlement) {
      // What was invoiced or paid is what was delivered: a late time from the phone is shown, not applied.
      const change = stopChange(e, stop);
      if (change.data) {
        await recordAudit({ entity: "load", action: "driver_link_flag", loadId: load.id, loadNumber: load.loadNumber, summary: `The driver's phone sent a time for ${where} after the load was ${load.paymentStatus ? "invoiced" : "on a driver statement"}; it was not applied.`, at: now, workspaceId, actor: ACTOR });
        res.flagged += 1;
      } else res.ignored += 1;
      continue;
    }
    const change = stopChange(e, stop);
    await prisma.$transaction(async (tx) => {
      if (change.data) {
        await tx.stop.update({ where: { id: stop.id }, data: change.data });
        const detail = change.data.waitMinutes != null ? `, waited ${change.data.waitMinutes} min` : "";
        const seal = change.data.sealNumber ? `, seal ${change.data.sealNumber}` : "";
        await recordAudit({ entity: "load", action: "stop_event", loadId: load.id, loadNumber: load.loadNumber, summary: `${EVENT_WORDS[e.kind] ?? e.kind} at ${where} ${dateTime(at)}${detail}${seal}, from the driver's phone`, at: now, workspaceId, actor: ACTOR }, tx);
      }
      if (change.clash) await recordAudit({ entity: "load", action: "driver_link_flag", loadId: load.id, loadNumber: load.loadNumber, summary: `The driver's phone says ${where}: ${change.clash}. The desk's entry was kept.`, at: now, workspaceId, actor: ACTOR }, tx);
    });
    if (change.clash) res.flagged += 1;
    if (change.data) res.applied += 1;
    else if (!change.clash) res.ignored += 1;
  }
  const was = wholeOf(ws.bridgeStopCursor);
  const last = events.length > 0 ? Math.max(...events.map((x) => wholeOf(x.sync_seq))) : was;
  if (last > was) await prisma.workspace.update({ where: { id: workspaceId }, data: { bridgeStopCursor: BigInt(last) } });
  res.cursor = Math.max(last, was);
  return res;
}
