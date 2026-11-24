import { terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { cityState } from "@/lib/city-state";
import { haversineMiles } from "@/lib/geo";
import { nearestPlace } from "@/lib/gazetteer/place-index";
import { equipmentCode, dwellSentence, idleLine, idleSentence } from "@/lib/radar";
import { hhmm } from "@/lib/shifts";
import { classifyTractor, durationText, dwell, engineStateOf, etaAt, geofence, roadMilesLeft, roadSchedule, stopsAhead, type TractorState } from "@/lib/telematics";
import { readRoadRoute, readWayThere } from "./road-route-cache";
import { zoneAbbr } from "@/lib/tz";
import { centralParts } from "@/lib/zoned";
import { boundsAround } from "@/lib/radius";
import { fixAge, mphText, whereIs, type Fix, type KnownStop, type UnitWhere } from "@/lib/whereabouts";
import { numOrNull } from "./convert";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * Where trucks and trailers are, for the rows on screen and for one unit's page. It reads only the units asked for (a page of fifty, or one), never the whole fleet, and looks for named
 * places only among the stops of recent loads that sit near those units. Nothing here calls a map provider: stored coordinates and the offline gazetteer only. Display only; no figure,
 * ranking or verdict ever reads it (tests/whereabouts-firewall.test.ts).
 */
const OPEN_LOAD = ["accepted", "in_progress"];
const OPEN_FOR_TRAILER = ["draft", "accepted", "in_progress"];
/** Stops on loads scheduled within this many days are the places the desk knows by name. */
export const KNOWN_STOP_DAYS = 90;
/** The reach of the box asked of the database around each unit; the exact tests then run in `whereIs`. */
const STOP_BOX_MILES = 6;

const town = (lat: number, lng: number, max: number) => nearestPlace(lat, lng, max);
const routeOf = (o: string | null, d: string | null): string => [o, d].map((a) => cityState(a)?.trim() ?? "").filter(Boolean).join(" → ");

const TRUCK_ICON: Record<TractorState, string> = { moving_load: "t-load", moving: "t-moving", idling: "t-idle", parked: "t-parked" };

const STATE_WORD: Record<TractorState, string> = { moving_load: "Moving under load", moving: "Moving, no load", idling: "Idling", parked: "Parked" };
const STOP_ROLE: Record<string, string> = { pickup: "PICKUP", delivery: "DELIVERY" };
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type DispatchLoad = {
  id: string;
  loadNumber: string | null;
  status: string;
  originAddress: string | null;
  destinationAddress: string | null;
  loadedMiles: unknown;
  stops: Array<{
    stopSequence: number;
    stopRole: string | null;
    stopType: string;
    facilityName: string | null;
    addressString: string;
    lat: unknown;
    lng: unknown;
    arrivedAt: Date | null;
    timeWindowEarliest: Date | null;
    timeWindowLatest: Date | null;
  }>;
};

type DispatchDriver = { name: string; hosDriveMinutes: number | null; hosShiftMinutes: number | null };

function hosText(vehicleHours: unknown, drivers: DispatchDriver[]): string | null {
  const d = drivers[0];
  const driverMins = d ? [d.hosDriveMinutes, d.hosShiftMinutes].filter((m): m is number => m != null) : [];
  const vh = numOrNull(vehicleHours as never);
  const mins = driverMins.length > 0 ? Math.min(...driverMins) : vh != null ? vh * 60 : null;
  if (mins == null || mins < 0) return null;
  return `${durationText(mins)} drive`;
}

function driverNames(drivers: DispatchDriver[]): string | null {
  const names = drivers.map((d) => d.name.trim()).filter(Boolean);
  return names.length > 0 ? names.join(" & ") : null;
}

function formatClock(ms: number, nowMs: number, tz: string): string {
  const clock = `${hhmm(ms, tz)} ${zoneAbbr(tz)}`;
  const today = centralParts(nowMs, tz);
  const that = centralParts(ms, tz);
  const sameDay = today.y === that.y && today.m0 === that.m0 && today.d === that.d;
  return sameDay ? clock : `${WEEKDAY[new Date(Date.UTC(that.y, that.m0, that.d)).getUTCDay()]} ${clock}`;
}

const placedStops = (load: DispatchLoad) =>
  load.stops
    .map((s) => ({ ...s, lat: numOrNull(s.lat as never), lng: numOrNull(s.lng as never) }))
    .filter((s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null);

/** Road miles left for a load, from the routes already kept in memory (a hover never fetches one). Null with none, or when the truck is on none of them. */
function keptMilesLeft(load: DispatchLoad, here: { lat: number; lng: number }, nowMs: number) {
  const placed = placedStops(load);
  if (placed.length < 2) return null;
  const { ahead, approaching } = stopsAhead(load.status, placed, here);
  return roadMilesLeft({ here, approaching, planned: readRoadRoute(load.id, placed, nowMs), way: readWayThere(load.id, ahead, nowMs)?.route });
}

/** ETA, schedule health, and next open stop summary: the arrival only on a road route and a fresh fix (nulls without enough stops or a fix). */
function loadDispatchEta(load: DispatchLoad | null, fix: Fix | null, speedMph: number | null, tz: string, nowMs: number): { eta: string | null; nextStop: string | null } {
  if (!load || load.stops.length === 0) return { eta: null, nextStop: null };
  const pending = load.stops.find((s) => s.arrivedAt == null) ?? load.stops[load.stops.length - 1]!;
  const role = STOP_ROLE[pending.stopRole ?? pending.stopType] ?? "STOP";
  const place = pending.facilityName?.trim() || cityState(pending.addressString)?.trim() || "";
  const dueAt = pending.timeWindowLatest ?? pending.timeWindowEarliest;
  const nextStop = [role, place || null, dueAt ? `due ${formatClock(dueAt.getTime(), nowMs, tz)}` : null].filter(Boolean).join(" · ") || null;

  if (!fix) return { eta: null, nextStop };
  const placed = placedStops(load);
  if (placed.length < 2) return { eta: null, nextStop };
  const destination = placed[placed.length - 1]!;
  const here = { lat: fix.lat, lng: fix.lng };
  if (geofence(here, destination).inside) return { eta: "AT DESTINATION", nextStop };

  const milesLeft = fixAge(fix.locatedAt, nowMs)?.old ? null : (keptMilesLeft(load, here, nowMs)?.miles ?? null);
  const sched = roadSchedule({ here, destination, milesLeft, speedMph, windowLatest: destination.timeWindowLatest, now: nowMs });
  const eta = [milesLeft != null ? `${milesLeft.toFixed(0)} mi left` : null, milesLeft != null ? formatClock(etaAt(nowMs, milesLeft, speedMph), nowMs, tz) : null, sched === "late" ? "RUNNING LATE" : sched === "on_schedule" ? "ON SCHEDULE" : null].filter(Boolean).join(" · ") || null;
  return { eta, nextStop };
}

/** Named stops (a load's facility name with a point) inside a box around each position. One query however many units there are. */
export async function knownStopsNear(points: ReadonlyArray<{ lat: number; lng: number }>, workspaceId = currentWorkspaceId(), now = new Date()): Promise<KnownStop[]> {
  if (points.length === 0) return [];
  const seen = new Set<string>();
  const boxes: Array<{ lat: { gte: number; lte: number }; lng: { gte: number; lte: number } }> = [];
  for (const p of points) {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = boundsAround(p, STOP_BOX_MILES);
    boxes.push({ lat: { gte: b.minLat, lte: b.maxLat }, lng: { gte: b.minLng, lte: b.maxLng } });
  }
  const since = new Date(now.getTime() - KNOWN_STOP_DAYS * 86_400_000);
  const rows = await prisma.stop.findMany({
    where: { facilityName: { not: null }, lat: { not: null }, lng: { not: null }, load: { workspaceId, deletedAt: null, OR: [{ scheduledDate: { gte: since } }, { scheduledDate: null, createdAt: { gte: since } }] }, OR: boxes },
    select: { facilityName: true, lat: true, lng: true },
    take: 2000
  });
  const out: KnownStop[] = [];
  for (const r of rows) {
    const lat = numOrNull(r.lat);
    const lng = numOrNull(r.lng);
    if (r.facilityName && lat != null && lng != null) out.push({ name: r.facilityName, lat, lng });
  }
  return out;
}

type FixSource = { lastLat: unknown; lastLng: unknown; lastLocatedAt: Date | null; lastSpeedMph?: unknown; lastHeadingDeg?: number | null; engineState?: string | null };

function fixOf(v: FixSource, standing?: boolean): Fix | null {
  const lat = numOrNull(v.lastLat as never);
  const lng = numOrNull(v.lastLng as never);
  if (lat == null || lng == null) return null;
  return { lat, lng, speedMph: numOrNull((v.lastSpeedMph ?? null) as never), engine: engineStateOf(v.engineState), headingDeg: v.lastHeadingDeg ?? null, locatedAt: v.lastLocatedAt, standing };
}

/** The fleet's average fuel price, so an idle line is priced the same way the radar prices it. */
async function fleetFuelPrice(workspaceId: string, terminal: Terminals): Promise<number | null> {
  const a = await prisma.costProfile.aggregate({ _avg: { lastFuelPricePerGallon: true }, where: { lastFuelPricePerGallon: { gt: 0 }, vehicle: { workspaceId, archivedAt: null, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) } } });
  return numOrNull(a._avg.lastFuelPricePerGallon);
}

const STOP_SELECT = {
  orderBy: { stopSequence: "asc" as const },
  select: { stopSequence: true, stopRole: true, stopType: true, facilityName: true, addressString: true, lat: true, lng: true, arrivedAt: true, timeWindowEarliest: true, timeWindowLatest: true }
};

/** Where each of these trucks is and what it is doing. Trucks with no position are still answered (with `where: null`). */
export async function getTruckWhere(ids: string[], workspaceId = currentWorkspaceId(), terminal: Terminals = null, now = new Date()): Promise<Map<string, UnitWhere>> {
  const out = new Map<string, UnitWhere>();
  if (ids.length === 0) return out;
  const [trucks, trailers, loads, fleetPrice] = await Promise.all([
    prisma.vehicle.findMany({
      where: { workspaceId, id: { in: ids } },
      select: {
        id: true, name: true, type: true, make: true, model: true,
        lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true, idleSince: true, hosAvailableHours: true,
        costProfile: { select: { lastFuelPricePerGallon: true } },
        drivers: { where: { active: true }, select: { name: true, hosDriveMinutes: true, hosShiftMinutes: true }, take: 2, orderBy: { name: "asc" } }
      }
    }),
    prisma.trailer.findMany({ where: { workspaceId, currentVehicleId: { in: ids }, archivedAt: null }, select: { id: true, number: true, currentVehicleId: true } }),
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, vehicleId: { in: ids }, status: { in: OPEN_LOAD } },
      select: { id: true, loadNumber: true, status: true, vehicleId: true, originAddress: true, destinationAddress: true, loadedMiles: true, stops: STOP_SELECT }
    }),
    fleetFuelPrice(workspaceId, terminal)
  ]);
  const fixes = trucks.map((t) => fixOf(t)).filter((f): f is Fix => f != null);
  const [stops, tz] = await Promise.all([knownStopsNear(fixes, workspaceId, now), workspaceTimezone(workspaceId)]);
  const trailerOf = new Map(trailers.map((t) => [t.currentVehicleId!, t]));
  const loadOf = new Map<string, (typeof loads)[number]>();
  for (const l of [...loads].sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1))) if (l.vehicleId && !loadOf.has(l.vehicleId)) loadOf.set(l.vehicleId, l);
  for (const t of trucks) {
    const load = loadOf.get(t.id) ?? null;
    const at = fixOf(t);
    const fix = at && load ? { ...at, roadName: keptMilesLeft(load, at, now.getTime())?.roadName ?? null } : at;
    const st = classifyTractor({ engine: engineStateOf(t.engineState), speedMph: numOrNull(t.lastSpeedMph), onLoad: load != null });
    const price = numOrNull(t.costProfile?.lastFuelPricePerGallon) ?? fleetPrice;
    const minutes = st === "idling" && t.idleSince ? Math.max(0, (now.getTime() - t.idleSince.getTime()) / 60_000) : null;
    const speed = numOrNull(t.lastSpeedMph);
    const tr = trailerOf.get(t.id);
    const dispatch = loadDispatchEta(load, fix, speed, tz, now.getTime());
    out.set(t.id, {
      kind: "truck",
      id: t.id,
      name: t.name ?? "Truck",
      sub: [t.make, t.model].filter(Boolean).join(" ") || (t.type?.replace("_", " ") ?? null),
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      icon: st ? TRUCK_ICON[st] : "t-none",
      headingDeg: st === "moving_load" || st === "moving" ? (t.lastHeadingDeg ?? 0) : 0,
      where: fix ? whereIs(fix, stops, town, now.getTime()) : null,
      state: st ? STATE_WORD[st] : null,
      speed: speed != null && speed >= 3 ? mphText(speed) : null,
      idle: minutes != null ? idleSentence(idleLine(minutes, price && price > 0 ? price : null)) : null,
      dwell: null,
      driver: driverNames(t.drivers),
      hos: hosText(t.hosAvailableHours, t.drivers),
      load: load ? { id: load.id, number: load.loadNumber ?? "A load", route: routeOf(load.originAddress, load.destinationAddress) } : null,
      eta: dispatch.eta,
      nextStop: dispatch.nextStop,
      typedPlace: null,
      hitched: tr ? { kind: "trailer", id: tr.id, name: tr.number } : null
    });
  }
  return out;
}

/** Where each of these trailers is. A hooked trailer is where its tractor is; a dropped one is where it was left, with how long it has sat. */
export async function getTrailerWhere(ids: string[], workspaceId = currentWorkspaceId(), now = new Date()): Promise<Map<string, UnitWhere>> {
  const out = new Map<string, UnitWhere>();
  if (ids.length === 0) return out;
  const trailers = await prisma.trailer.findMany({
    where: { workspaceId, id: { in: ids } },
    select: { id: true, number: true, type: true, lengthFt: true, location: true, currentVehicleId: true, lastLat: true, lastLng: true, lastLocatedAt: true, unhookedAt: true, dwellRateOverride: true, dwellDaysOverride: true, dwellWaived: true }
  });
  const truckIds = [...new Set(trailers.map((t) => t.currentVehicleId).filter((x): x is string => x != null))];
  const [trucks, loads, terms] = await Promise.all([
    truckIds.length
      ? prisma.vehicle.findMany({
          where: { workspaceId, id: { in: truckIds } },
          select: {
            id: true, name: true, lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true, hosAvailableHours: true,
            drivers: { where: { active: true }, select: { name: true, hosDriveMinutes: true, hosShiftMinutes: true }, take: 2, orderBy: { name: "asc" } }
          }
        })
      : [],
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, trailerId: { in: ids }, status: { in: OPEN_FOR_TRAILER } },
      select: { id: true, loadNumber: true, status: true, trailerId: true, originAddress: true, destinationAddress: true, loadedMiles: true, stops: STOP_SELECT }
    }),
    getThresholds(workspaceId)
  ]);
  const truckOf = new Map(trucks.map((t) => [t.id, t]));
  const loadOf = new Map<string, (typeof loads)[number]>();
  for (const l of [...loads].sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1))) if (l.trailerId && !loadOf.has(l.trailerId)) loadOf.set(l.trailerId, l);
  const reloaded = new Set(loads.map((l) => l.trailerId).filter((x): x is string => x != null));
  const fixFor = (t: (typeof trailers)[number]): Fix | null => {
    const tractor = t.currentVehicleId ? truckOf.get(t.currentVehicleId) : undefined;
    return (tractor ? fixOf(tractor) : null) ?? fixOf(t, true);
  };
  const [stops, tz] = await Promise.all([knownStopsNear(trailers.map(fixFor).filter((f): f is Fix => f != null), workspaceId, now), workspaceTimezone(workspaceId)]);
  for (const t of trailers) {
    const at = fixFor(t);
    const tractor = t.currentVehicleId ? truckOf.get(t.currentVehicleId) : undefined;
    const load = loadOf.get(t.id) ?? null;
    const fix = at && load ? { ...at, roadName: keptMilesLeft(load, at, now.getTime())?.roadName ?? null } : at;
    const d = t.currentVehicleId ? null : dwell(t.unhookedAt, now.getTime(), { freeHours: terms.dwellFreeHours, perDay: terms.dwellPerDayRate }, reloaded.has(t.id), { ratePerDay: numOrNull(t.dwellRateOverride), billableDays: numOrNull(t.dwellDaysOverride), waived: t.dwellWaived });
    const speed = tractor ? numOrNull(tractor.lastSpeedMph) : null;
    const loaded = load?.status === "in_progress";
    const dispatch = loadDispatchEta(load, fix, speed, tz, now.getTime());
    out.set(t.id, {
      kind: "trailer",
      id: t.id,
      name: t.number,
      sub: equipmentCode(t.type, numOrNull(t.lengthFt)) || null,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      icon: `tr-${d?.alert ? "a" : tractor ? "h" : "d"}-${loaded ? "l" : "e"}`,
      headingDeg: 0,
      where: fix ? whereIs(fix, stops, town, now.getTime()) : null,
      state: tractor ? (loaded ? "Hooked, loaded" : "Hooked") : "Dropped",
      speed: speed != null && speed >= 3 ? mphText(speed) : null,
      idle: null,
      dwell: d ? dwellSentence(d, terms.dwellFreeHours) : null,
      driver: tractor ? driverNames(tractor.drivers) : null,
      hos: tractor ? hosText(tractor.hosAvailableHours, tractor.drivers) : null,
      load: load ? { id: load.id, number: load.loadNumber ?? "A load", route: routeOf(load.originAddress, load.destinationAddress) } : null,
      eta: dispatch.eta,
      nextStop: dispatch.nextStop,
      typedPlace: t.location?.trim() || null,
      hitched: tractor ? { kind: "tractor", id: tractor.id, name: tractor.name ?? "a tractor" } : null
    });
  }
  return out;
}
