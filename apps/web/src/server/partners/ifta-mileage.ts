import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CA_PROVINCES, US_STATES } from "@/lib/fuel-normalize";
import { spreadLeg, truckLegs, type IftaLeg, type LegLoad } from "@/lib/ifta-legs";
import { countedRows, countedSource, type IftaMethod } from "@/lib/ifta-mileage";
import { isIftaQuarter } from "@/lib/ifta-rates-csv";
import { centralInstant } from "@/lib/zoned";
import { recordAudit } from "@/server/tl/audit";
import { numOrNull } from "@/server/tl/convert";
import { lockWorkspace } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { callPartner, providerName, type IftaTripHint } from "./call";

/** The most loads one quarter's read is worked from. A quarter with more says so rather than quietly leaving the rest out. */
export const IFTA_MAX_LOADS = 20_000;

/** A quarter's bounds in the workspace's own calendar, `to` exclusive. Null for anything that is not a quarter. */
export const quarterBounds = (quarter: string, tz: string): { from: Date; to: Date } | null => {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const q = parseInt(m[2]!, 10);
  return { from: new Date(centralInstant(year, (q - 1) * 3, 1, 0, 0, tz)), to: new Date(centralInstant(year, q * 3, 1, 0, 0, tz)) };
};

/**
 * A quarter's miles by state as the ELD reported them (money plan Wave 5 step 5a): every piece each truck drove, loaded or empty, with its odometers and times, kept in `ifta_mileage` for the
 * return (step 6) and the per-truck audit (step 7). The quarter is the workspace's own calendar; a piece belongs to the quarter it starts in.
 *
 * The desk hands the ELD each truck's loads around the quarter (places, pickup and delivery times, loaded and empty miles) so a piece can be tied to the load it was driven on; the simulator
 * also drives the trucks from them. A read REPLACES what the answered trucks had for the quarter from that ELD, with the workspace locked, in one transaction, with one audit event: reading the
 * same quarter twice, or two reads at once, never doubles a piece (the unique key on the company's piece id is the backstop). A truck the ELD reported nothing for keeps what it had, and is
 * counted as "no ELD miles" for step 5b's routed fallback. Canadian miles are counted and said, not kept (gap 15). Only the billing office reaches it (the action checks `bill`).
 */
export type IftaMileageSync =
  | {
      ok: true;
      provider: string;
      batchId: string;
      quarter: string;
      /** Trucks the ELD answered for, and trucks asked about that it reported nothing for. */
      trucks: number;
      notAnswered: number;
      pieces: number;
      /** Pieces the answered trucks had for the quarter before, all replaced. */
      replaced: number;
      states: number;
      miles: string;
      loadedMiles: string;
      emptyMiles: string;
      canadaMiles: string;
      skipped: { outsideQuarter: number; afterAsOf: number; unreadable: number; duplicate: number };
    }
  | { ok: false; error: string; code?: string };

const BAD_QUARTER = "A quarter, like 2026-Q3.";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** How far either side of the quarter a load is looked at: a load picked up in one quarter and delivered in the next has pieces in both. */
const MARGIN = 31 * DAY;
const CHUNK = 500;
const whole = (n: number) => n - (n % 1);
const n1 = (d: Prisma.Decimal) => d.toNumber().toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (v: number, one: string, many: string) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;

type HintLoad = {
  id: string;
  vehicleId: string | null;
  status: string;
  originAddress: string | null;
  destinationAddress: string | null;
  loadedMiles: Prisma.Decimal;
  pickupDeadheadMiles: Prisma.Decimal;
  returnDeadheadMiles: Prisma.Decimal;
  completedAt: Date | null;
  stops: Array<{ addressString: string; arrivedAt: Date | null; timeWindowEarliest: Date | null; timeWindowLatest: Date | null }>;
};

/**
 * A load as a trip hint: picked up when the first stop was arrived at (else its window), delivered when the load was completed (else the last stop's arrival or window). With no pickup time the
 * load is taken to have started its loaded miles' drive time (50 mph) before delivery. A load with no delivery time, or with no place at either end, gives none.
 */
export function hintOf(l: HintLoad): IftaTripHint | null {
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const delivered = (l.completedAt ?? last?.arrivedAt ?? last?.timeWindowLatest ?? last?.timeWindowEarliest)?.getTime();
  if (delivered == null) return null;
  const origin = l.originAddress ?? first?.addressString ?? null;
  const destination = l.destinationAddress ?? last?.addressString ?? null;
  if (!origin || !destination) return null;
  const drive = whole(l.loadedMiles.div(50).times(HOUR).toNumber());
  let picked = (first?.arrivedAt ?? first?.timeWindowEarliest ?? first?.timeWindowLatest)?.getTime() ?? delivered - drive;
  if (picked >= delivered) picked = delivered - (drive > HOUR ? drive : HOUR);
  return { loadId: l.id, origin, destination, pickupAt: picked, deliveredAt: delivered, loadedMiles: l.loadedMiles.toFixed(4), pickupDeadheadMiles: l.pickupDeadheadMiles.toFixed(4), returnDeadheadMiles: l.returnDeadheadMiles.toFixed(4) };
}

/** Every load around the quarter (completed in it, give or take a month, or on the road now), with its stops in sequence order. Null when there are more than one read is worked from. */
async function quarterLoads(workspaceId: string, bounds: { from: Date; to: Date }) {
  const loads = await prisma.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      vehicleId: { not: null },
      OR: [{ status: "completed", completedAt: { gte: new Date(bounds.from.getTime() - MARGIN), lt: new Date(bounds.to.getTime() + MARGIN) } }, { status: "in_progress" }]
    },
    select: {
      id: true,
      vehicleId: true,
      status: true,
      originAddress: true,
      destinationAddress: true,
      loadedMiles: true,
      pickupDeadheadMiles: true,
      returnDeadheadMiles: true,
      completedAt: true,
      stops: { orderBy: { stopSequence: "asc" }, select: { stopSequence: true, addressString: true, lat: true, lng: true, arrivedAt: true, timeWindowEarliest: true, timeWindowLatest: true } }
    },
    orderBy: { id: "asc" },
    take: IFTA_MAX_LOADS + 1
  });
  return loads.length > IFTA_MAX_LOADS ? null : loads;
}

/** Each truck's loads that touch the quarter (delivered or on the road), as trip hints in pickup order. */
async function hintsFor(workspaceId: string, bounds: { from: Date; to: Date }): Promise<Map<string, IftaTripHint[]> | null> {
  const loads = await quarterLoads(workspaceId, bounds);
  if (!loads) return null;
  const out = new Map<string, IftaTripHint[]>();
  for (const l of loads) {
    const h = hintOf(l);
    if (!h || !l.vehicleId) continue;
    // Only what could have a piece in the quarter: picked up (less a day for the empty run) before it ends, delivered (plus a day for the run home) after it begins.
    if (h.pickupAt - DAY >= bounds.to.getTime() || h.deliveredAt + DAY < bounds.from.getTime()) continue;
    out.set(l.vehicleId, [...(out.get(l.vehicleId) ?? []), h]);
  }
  for (const list of out.values()) list.sort((a, b) => a.pickupAt - b.pickupAt || a.loadId.localeCompare(b.loadId));
  return out;
}

export async function syncIftaMileage(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaMileageSync> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER, code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const bounds = quarterBounds(quarter, tz)!;
  const hints = await hintsFor(workspaceId, bounds);
  if (!hints) return { ok: false, error: `${quarter} has more than ${IFTA_MAX_LOADS.toLocaleString("en-US")} loads around it, which is more than one read is worked from.`, code: "bad_request" };
  const trucks = await prisma.vehicle.findMany({
    where: { workspaceId, OR: [{ archivedAt: null }, { id: { in: [...hints.keys()] } }] },
    select: { id: true, name: true, eldVehicleId: true, homeBaseAddress: true },
    orderBy: { id: "asc" }
  });
  const { provider, result } = await callPartner(
    "eld",
    null,
    { op: "ifta_trips", quarter, from: bounds.from.toISOString(), to: bounds.to.toISOString(), asOf: now.getTime(), vehicles: trucks.map((t) => ({ id: t.id, name: t.name, eldVehicleId: t.eldVehicleId, home: t.homeBaseAddress, trips: hints.get(t.id) ?? [] })) },
    workspaceId
  );
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const answer = result.data.iftaTrips;
  if (!answer) return { ok: false, error: `${providerName(provider)} did not send a quarter's miles.`, code: "upstream_error" };

  const known = new Set(trucks.map((t) => t.id));
  const answered = answer.answered.filter((id) => known.has(id));
  const mine = new Set(answered);
  const pieces = answer.pieces.filter((p) => mine.has(p.vehicleId));
  const canada = answer.canada.filter((c) => mine.has(c.vehicleId));
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const name = providerName(provider);
  const sum = (xs: Array<{ miles: string }>) => xs.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0));
  const miles = sum(pieces);
  const loadedMiles = sum(pieces.filter((p) => p.loaded));
  const emptyMiles = miles.minus(loadedMiles);
  const canadaMiles = sum(canada);
  const states = new Set(pieces.map((p) => p.jurisdiction)).size;
  const notAnswered = trucks.length - answered.length;
  const skipped = answer.skipped;
  const left = skipped.outsideQuarter + skipped.afterAsOf + skipped.unreadable + skipped.duplicate;

  const replaced = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Wave 5 step 8: once a filed return (IftaReturn) holds this quarter, refuse here, or warn and require a confirm, before the miles it was worked out from are replaced.
      // A load removed since the read keeps its pieces as loaded with no load.
      const loadIds = [...new Set(pieces.flatMap((p) => (p.loadId ? [p.loadId] : [])))];
      const live = new Set<string>();
      for (let i = 0; i < loadIds.length; i += CHUNK) for (const l of await tx.load.findMany({ where: { workspaceId, id: { in: loadIds.slice(i, i + CHUNK) } }, select: { id: true } })) live.add(l.id);
      // The answered trucks' quarter from this ELD goes, and any row holding one of the new pieces' ids (a piece that moved truck or quarter), so the insert can never meet itself.
      const before = answered.length === 0 ? 0 : await tx.iftaMileage.count({ where: { workspaceId, source: provider, method: "eld", quarter, vehicleId: { in: answered } } });
      if (answered.length > 0) await tx.iftaMileage.deleteMany({ where: { workspaceId, source: provider, method: "eld", quarter, vehicleId: { in: answered } } });
      const ids = pieces.map((p) => p.externalId);
      for (let i = 0; i < ids.length; i += CHUNK) await tx.iftaMileage.deleteMany({ where: { workspaceId, source: provider, method: "eld", externalId: { in: ids.slice(i, i + CHUNK) } } });
      for (let i = 0; i < pieces.length; i += CHUNK) {
        await tx.iftaMileage.createMany({
          data: pieces.slice(i, i + CHUNK).map((p) => ({
            workspaceId,
            vehicleId: p.vehicleId,
            quarter,
            jurisdiction: p.jurisdiction,
            source: provider,
            externalId: p.externalId,
            method: "eld",
            loadId: p.loadId != null && live.has(p.loadId) ? p.loadId : null,
            loaded: p.loaded,
            startOdometer: new Prisma.Decimal(p.startOdometer),
            endOdometer: new Prisma.Decimal(p.endOdometer),
            miles: new Prisma.Decimal(p.miles),
            startedAt: new Date(p.startedAt),
            endedAt: new Date(p.endedAt),
            syncBatchId: batchId,
            syncedAt: now
          }))
        });
      }
      const parts = [
        pieces.length > 0
          ? `${quarter} ELD miles read from ${name}: ${n1(miles)} miles in ${plural(states, "state", "states")} for ${plural(answered.length, "truck", "trucks")} (${n1(loadedMiles)} loaded, ${n1(emptyMiles)} empty)`
          : `${quarter} ELD miles read from ${name}: no miles reported${answered.length > 0 ? ` for ${plural(answered.length, "truck", "trucks")}` : ""}`,
        before > 0 ? `replacing ${plural(before, "piece", "pieces")}` : null,
        canada.length > 0 ? `${n1(canadaMiles)} miles in Canada not counted (gap 15)` : null,
        notAnswered > 0 ? `${plural(notAnswered, "truck", "trucks")} with no ELD miles` : null,
        left > 0 ? `${plural(left, "piece", "pieces")} left out` : null
      ].filter(Boolean);
      await recordAudit(
        {
          entity: "fleet",
          entityId: batchId,
          action: "ifta_miles_synced",
          summary: parts.join("; "),
          before: before > 0 ? { Pieces: String(before) } : null,
          after: {
            Quarter: quarter,
            Source: name,
            Trucks: String(answered.length),
            "No ELD miles": String(notAnswered),
            Pieces: String(pieces.length),
            Miles: miles.toFixed(1),
            Loaded: loadedMiles.toFixed(1),
            Empty: emptyMiles.toFixed(1),
            "Canada, not counted (gap 15)": canadaMiles.toFixed(1),
            "Outside the quarter": String(skipped.outsideQuarter),
            "After the desk's clock": String(skipped.afterAsOf),
            Unreadable: String(skipped.unreadable),
            Duplicates: String(skipped.duplicate)
          },
          at: now,
          workspaceId
        },
        tx
      );
      return before;
    },
    { timeout: 60_000 }
  );
  return { ok: true, provider, batchId, quarter, trucks: answered.length, notAnswered, pieces: pieces.length, replaced, states, miles: miles.toFixed(1), loadedMiles: loadedMiles.toFixed(1), emptyMiles: emptyMiles.toFixed(1), canadaMiles: canadaMiles.toFixed(1), skipped };
}


// ── The routed fallback (Wave 5 step 5b) ─────────────────────────────────────────────────────

export type IftaRouteResult =
  | {
      ok: true;
      provider: string;
      batchId: string;
      quarter: string;
      /** Trucks routed, and trucks left to their ELD rows (never routed over). */
      trucks: number;
      eldTrucks: number;
      legs: number;
      /** Legs the router gave no miles for, and legs still under way at the desk's clock (not driven yet, so not routed). */
      unrouted: number;
      notYet: number;
      pieces: number;
      replaced: number;
      states: number;
      miles: string;
      loadedMiles: string;
      emptyMiles: string;
      canadaMiles: string;
      /** Loads in the quarter with no time, or fewer than two stops; first loads with empty miles and no home base to start from (no leg invented). */
      untimed: number;
      tooFewStops: number;
      noStart: number;
    }
  | { ok: false; error: string; code?: string };

/**
 * A load's stops for routing, in sequence order. A load kept with fewer than two stops but with its origin and destination written (an imported one) is routed between those two places, picked
 * up at its first stop's time if it has one and delivered when it was completed.
 */
function legStops(l: NonNullable<Awaited<ReturnType<typeof quarterLoads>>>[number]): LegLoad["stops"] {
  const time = (s: { arrivedAt: Date | null; timeWindowEarliest: Date | null; timeWindowLatest: Date | null }) => (s.arrivedAt ?? s.timeWindowEarliest ?? s.timeWindowLatest)?.getTime() ?? null;
  if (l.stops.length >= 2 || !l.originAddress || !l.destinationAddress) return l.stops.map((s) => ({ sequence: s.stopSequence, place: s.addressString, at: time(s), lat: numOrNull(s.lat), lng: numOrNull(s.lng) }));
  const first = l.stops[0];
  return [
    { sequence: 1, place: l.originAddress, at: first ? time(first) : null },
    { sequence: 2, place: l.destinationAddress, at: l.completedAt?.getTime() ?? null }
  ];
}

type RoutedPiece = { vehicleId: string; externalId: string; jurisdiction: string; loaded: boolean; loadId: string | null; miles: string; startedAt: Date; endedAt: Date };

/**
 * Route the trucks the ELD did not report and keep their legs as routed miles (`method` "routed"). ELD first, on the write: a truck with any ELD rows for the quarter is never routed (checked
 * again under the lock, so an ELD read that lands in between wins). The quarter's routed rows from this router are replaced as a whole, with the workspace locked, in one transaction, with one
 * audit event: routing again gives the same rows (the ids come from the loads and stops), never more. A leg belongs to the quarter it starts in, and one still under way at the desk's clock is
 * left for the next read. Canadian miles are counted and not kept (gap 15).
 */
export async function routeIftaMiles(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaRouteResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER, code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const bounds = quarterBounds(quarter, tz)!;
  const loads = await quarterLoads(workspaceId, bounds);
  if (!loads) return { ok: false, error: `${quarter} has more than ${IFTA_MAX_LOADS.toLocaleString("en-US")} loads around it, which is more than one read is worked from.`, code: "bad_request" };
  const coveredNow = async (db: Pick<typeof prisma, "iftaMileage">) => new Set((await db.iftaMileage.groupBy({ by: ["vehicleId"], where: { workspaceId, quarter, method: "eld" } })).map((r) => r.vehicleId));
  const covered = await coveredNow(prisma);

  const byTruck = new Map<string, LegLoad[]>();
  for (const l of loads) {
    if (!l.vehicleId || covered.has(l.vehicleId)) continue;
    const legLoad: LegLoad = {
      loadId: l.id,
      completedAt: l.completedAt?.getTime() ?? null,
      loadedMiles: l.loadedMiles.toFixed(4),
      pickupDeadheadMiles: l.pickupDeadheadMiles.toFixed(4),
      stops: legStops(l)
    };
    byTruck.set(l.vehicleId, [...(byTruck.get(l.vehicleId) ?? []), legLoad]);
  }
  const homes = new Map((await prisma.vehicle.findMany({ where: { workspaceId, id: { in: [...byTruck.keys()] } }, select: { id: true, homeBaseAddress: true } })).map((v) => [v.id, v.homeBaseAddress?.trim() || null]));

  const from = bounds.from.getTime();
  const to = bounds.to.getTime();
  const legs: Array<IftaLeg & { vehicleId: string }> = [];
  let untimed = 0;
  let tooFewStops = 0;
  let noStart = 0;
  let notYet = 0;
  for (const [vehicleId, list] of [...byTruck].sort(([a], [b]) => a.localeCompare(b))) {
    const t = truckLegs(list, homes.get(vehicleId) ?? null);
    for (const leg of t.legs) {
      if (leg.startsAt < from || leg.startsAt >= to) continue;
      if (leg.endsAt > now.getTime()) {
        notYet += 1;
        continue;
      }
      legs.push({ ...leg, vehicleId });
    }
    // Only loads delivered in the quarter are reported as gaps.
    const inQuarter = new Set(list.filter((l) => l.completedAt != null && l.completedAt >= from && l.completedAt < to).map((l) => l.loadId));
    untimed += t.untimed.filter((id) => inQuarter.has(id)).length;
    tooFewStops += t.tooFewStops.filter((id) => inQuarter.has(id)).length;
    noStart += t.noStart.filter((id) => inQuarter.has(id)).length;
  }

  const legId = (l: { vehicleId: string; key: string }) => `${l.vehicleId}|${l.key}`;
  const { provider, result } = await callPartner("ifta", null, { quarter, legs: legs.map((l) => ({ id: legId(l), vehicleId: l.vehicleId, origin: l.from, destination: l.to, miles: l.miles })) }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The mileage company could not be reached.", code: result.code };
  const answered = new Map(result.data.legs.map((l) => [l.id, l.jurisdictions]));
  const pieces: RoutedPiece[] = [];
  let canadaMiles = new Prisma.Decimal(0);
  for (const leg of legs) {
    spreadLeg(leg, answered.get(legId(leg)) ?? []).forEach((p, i) => {
      if (CA_PROVINCES[p.state] != null) canadaMiles = canadaMiles.plus(p.miles);
      else if (US_STATES[p.state] != null) pieces.push({ vehicleId: leg.vehicleId, externalId: `${leg.key}:${i}:${p.state}`, jurisdiction: p.state, loaded: leg.loaded, loadId: leg.loadId, miles: p.miles, startedAt: new Date(p.startedAt), endedAt: new Date(p.endedAt) });
    });
  }
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const name = providerName(provider);

  const out = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Wave 5 step 8: once a filed return (IftaReturn) holds this quarter, refuse here, or warn and require a confirm, before the routed miles it was worked out from are replaced.
      // ELD first, again under the lock: a truck the ELD reported since the read above is not routed.
      const eld = await coveredNow(tx);
      const kept = pieces.filter((p) => !eld.has(p.vehicleId));
      const loadIds = [...new Set(kept.flatMap((p) => (p.loadId ? [p.loadId] : [])))];
      const live = new Set<string>();
      for (let i = 0; i < loadIds.length; i += CHUNK) for (const l of await tx.load.findMany({ where: { workspaceId, id: { in: loadIds.slice(i, i + CHUNK) } }, select: { id: true } })) live.add(l.id);
      // The quarter's routed rows from this router go whole (every truck, so a truck the ELD now covers loses its stale routed rows too), and any row holding one of the new ids.
      const before = await tx.iftaMileage.count({ where: { workspaceId, quarter, method: "routed", source: provider } });
      await tx.iftaMileage.deleteMany({ where: { workspaceId, quarter, method: "routed", source: provider } });
      const ids = kept.map((p) => p.externalId);
      for (let i = 0; i < ids.length; i += CHUNK) await tx.iftaMileage.deleteMany({ where: { workspaceId, method: "routed", source: provider, externalId: { in: ids.slice(i, i + CHUNK) } } });
      for (let i = 0; i < kept.length; i += CHUNK) {
        await tx.iftaMileage.createMany({
          data: kept.slice(i, i + CHUNK).map((p) => ({
            workspaceId,
            vehicleId: p.vehicleId,
            quarter,
            jurisdiction: p.jurisdiction,
            source: provider,
            externalId: p.externalId,
            method: "routed",
            loadId: p.loadId != null && live.has(p.loadId) ? p.loadId : null,
            loaded: p.loaded,
            startOdometer: null,
            endOdometer: null,
            miles: new Prisma.Decimal(p.miles),
            startedAt: p.startedAt,
            endedAt: p.endedAt,
            syncBatchId: batchId,
            syncedAt: now
          }))
        });
      }
      const sum = (xs: RoutedPiece[]) => xs.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0));
      const miles = sum(kept);
      const loadedMiles = sum(kept.filter((p) => p.loaded));
      const trucks = new Set(kept.map((p) => p.vehicleId)).size;
      const states = new Set(kept.map((p) => p.jurisdiction)).size;
      const unrouted = result.data.skipped.unrouted;
      const parts = [
        kept.length > 0
          ? `${quarter} miles routed by ${name} for ${plural(trucks, "truck", "trucks")} without ELD miles: ${n1(miles)} miles in ${plural(states, "state", "states")} (${n1(loadedMiles)} loaded, ${n1(miles.minus(loadedMiles))} empty)`
          : `${quarter} miles routed by ${name}: nothing to route`,
        eld.size > 0 ? `${plural(eld.size, "truck", "trucks")} left to ELD miles` : null,
        before > 0 ? `replacing ${plural(before, "piece", "pieces")}` : null,
        canadaMiles.gt(0) ? `${n1(canadaMiles)} miles in Canada not counted (gap 15)` : null,
        unrouted > 0 ? `${plural(unrouted, "leg", "legs")} not routed` : null,
        noStart > 0 ? `${plural(noStart, "first load", "first loads")} with no home base to start from` : null,
        untimed + tooFewStops > 0 ? `${plural(untimed + tooFewStops, "load", "loads")} with no time or fewer than two stops` : null
      ].filter(Boolean);
      await recordAudit(
        {
          entity: "fleet",
          entityId: batchId,
          action: "ifta_miles_routed",
          summary: parts.join("; "),
          before: before > 0 ? { Pieces: String(before) } : null,
          after: {
            Quarter: quarter,
            Router: name,
            Trucks: String(trucks),
            "Left to ELD miles": String(eld.size),
            Legs: String(legs.length),
            Pieces: String(kept.length),
            Miles: miles.toFixed(1),
            Loaded: loadedMiles.toFixed(1),
            Empty: miles.minus(loadedMiles).toFixed(1),
            "Canada, not counted (gap 15)": canadaMiles.toFixed(1),
            "Not routed": String(unrouted),
            "Under way": String(notYet),
            "No home base to start from": String(noStart),
            "No time": String(untimed),
            "Fewer than two stops": String(tooFewStops)
          },
          at: now,
          workspaceId
        },
        tx
      );
      return { before, trucks, states, eldTrucks: eld.size, pieces: kept.length, miles, loadedMiles, unrouted };
    },
    { timeout: 60_000 }
  );
  return {
    ok: true,
    provider,
    batchId,
    quarter,
    trucks: out.trucks,
    eldTrucks: out.eldTrucks,
    legs: legs.length,
    unrouted: out.unrouted,
    notYet,
    pieces: out.pieces,
    replaced: out.before,
    states: out.states,
    miles: out.miles.toFixed(1),
    loadedMiles: out.loadedMiles.toFixed(1),
    emptyMiles: out.miles.minus(out.loadedMiles).toFixed(1),
    canadaMiles: canadaMiles.toFixed(1),
    untimed,
    tooFewStops,
    noStart
  };
}

// ── Reading a quarter: ELD first, per truck ──────────────────────────────────────────────────

export type IftaQuarterMiles = {
  quarter: string;
  trucks: Array<{ vehicleId: string; name: string | null; method: IftaMethod; source: string; miles: string; loadedMiles: string; emptyMiles: string; pieces: number; syncedAt: Date | null }>;
  states: Array<{ state: string; miles: string; loadedMiles: string; emptyMiles: string }>;
  /** How many trucks count each method and company ("ELD miles (Motive) for 6 trucks · routed (ProMiles) for 2"). */
  sources: Array<{ method: IftaMethod; source: string; trucks: number }>;
  /** Trucks whose routed rows are set aside because the ELD reported them. */
  setAside: number;
  miles: string;
  loadedMiles: string;
  emptyMiles: string;
  pieces: number;
  syncedAt: Date | null;
};

/** The quarter's miles as every reader counts them: each truck's ELD rows if it has any, else its routed rows (lib/ifta-mileage.ts). Null for anything that is not a quarter. */
export async function iftaQuarterMiles(quarter: string, workspaceId = currentWorkspaceId()): Promise<IftaQuarterMiles | null> {
  if (!isIftaQuarter(quarter)) return null;
  const groups = await prisma.iftaMileage.groupBy({ by: ["vehicleId", "method", "source", "jurisdiction", "loaded"], where: { workspaceId, quarter }, _sum: { miles: true }, _count: { _all: true }, _max: { syncedAt: true } });
  const perSource = new Map<string, { vehicleId: string; method: string; source: string; syncedAt: Date | null }>();
  for (const g of groups) {
    const k = `${g.vehicleId}|${g.method}|${g.source}`;
    const had = perSource.get(k);
    const at = g._max.syncedAt ?? null;
    if (!had || (at && (!had.syncedAt || at > had.syncedAt))) perSource.set(k, { vehicleId: g.vehicleId, method: g.method, source: g.source, syncedAt: at ?? had?.syncedAt ?? null });
  }
  const chosen = countedSource([...perSource.values()]);
  const counted = countedRows(groups, chosen);
  const routedTrucks = new Set(groups.filter((g) => g.method === "routed").map((g) => g.vehicleId));
  const setAside = [...routedTrucks].filter((v) => chosen.get(v)?.method === "eld").length;
  const names = new Map((await prisma.vehicle.findMany({ where: { workspaceId, id: { in: [...chosen.keys()] } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
  const zero = () => new Prisma.Decimal(0);
  const add = (xs: typeof counted) => xs.reduce((s, g) => s.plus(g._sum.miles ?? 0), zero());
  const trucks = [...chosen].map(([vehicleId, c]) => {
    const mine = counted.filter((g) => g.vehicleId === vehicleId);
    const loaded = add(mine.filter((g) => g.loaded));
    const all = add(mine);
    const at = mine.reduce<Date | null>((m, g) => (g._max.syncedAt && (!m || g._max.syncedAt > m) ? g._max.syncedAt : m), null);
    return { vehicleId, name: names.get(vehicleId) ?? null, method: c.method, source: c.source, miles: all.toFixed(1), loadedMiles: loaded.toFixed(1), emptyMiles: all.minus(loaded).toFixed(1), pieces: mine.reduce((s, g) => s + g._count._all, 0), syncedAt: at };
  });
  trucks.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.vehicleId.localeCompare(b.vehicleId));
  const states = [...new Set(counted.map((g) => g.jurisdiction))].sort().map((state) => {
    const mine = counted.filter((g) => g.jurisdiction === state);
    const loaded = add(mine.filter((g) => g.loaded));
    const all = add(mine);
    return { state, miles: all.toFixed(1), loadedMiles: loaded.toFixed(1), emptyMiles: all.minus(loaded).toFixed(1) };
  });
  const bySource = new Map<string, { method: IftaMethod; source: string; trucks: number }>();
  for (const c of chosen.values()) {
    const k = `${c.method}|${c.source}`;
    bySource.set(k, { method: c.method, source: c.source, trucks: (bySource.get(k)?.trucks ?? 0) + 1 });
  }
  const sources = [...bySource.values()].sort((a, b) => (a.method === b.method ? a.source.localeCompare(b.source) : a.method === "eld" ? -1 : 1));
  const total = trucks.reduce((s, t) => s.plus(t.miles), zero());
  const loadedTotal = trucks.reduce((s, t) => s.plus(t.loadedMiles), zero());
  return {
    quarter,
    trucks,
    states,
    sources,
    setAside,
    miles: total.toFixed(1),
    loadedMiles: loadedTotal.toFixed(1),
    emptyMiles: total.minus(loadedTotal).toFixed(1),
    pieces: trucks.reduce((s, t) => s + t.pieces, 0),
    syncedAt: trucks.reduce<Date | null>((m, t) => (t.syncedAt && (!m || t.syncedAt > m) ? t.syncedAt : m), null)
  };
}
