import { terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { cityState } from "@/lib/city-state";
import { nearestPlace } from "@/lib/gazetteer/place-index";
import { equipmentCode, dwellSentence, idleLine, idleSentence } from "@/lib/radar";
import { classifyTractor, dwell, engineStateOf, type TractorState } from "@/lib/telematics";
import { boundsAround } from "@/lib/radius";
import { mphText, whereIs, type Fix, type KnownStop, type UnitWhere } from "@/lib/whereabouts";
import { numOrNull } from "./convert";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

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

/** Where each of these trucks is and what it is doing. Trucks with no position are still answered (with `where: null`). */
export async function getTruckWhere(ids: string[], workspaceId = currentWorkspaceId(), terminal: Terminals = null, now = new Date()): Promise<Map<string, UnitWhere>> {
  const out = new Map<string, UnitWhere>();
  if (ids.length === 0) return out;
  const [trucks, trailers, loads, fleetPrice] = await Promise.all([
    prisma.vehicle.findMany({
      where: { workspaceId, id: { in: ids } },
      select: {
        id: true, name: true, type: true, make: true, model: true,
        lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true, idleSince: true,
        costProfile: { select: { lastFuelPricePerGallon: true } },
        drivers: { where: { active: true }, select: { name: true }, take: 1, orderBy: { name: "asc" } }
      }
    }),
    prisma.trailer.findMany({ where: { workspaceId, currentVehicleId: { in: ids }, archivedAt: null }, select: { id: true, number: true, currentVehicleId: true } }),
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, vehicleId: { in: ids }, status: { in: OPEN_LOAD } },
      select: { id: true, loadNumber: true, status: true, vehicleId: true, originAddress: true, destinationAddress: true }
    }),
    fleetFuelPrice(workspaceId, terminal)
  ]);
  const fixes = trucks.map((t) => fixOf(t)).filter((f): f is Fix => f != null);
  const stops = await knownStopsNear(fixes, workspaceId, now);
  const trailerOf = new Map(trailers.map((t) => [t.currentVehicleId!, t]));
  const loadOf = new Map<string, (typeof loads)[number]>();
  for (const l of [...loads].sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1))) if (l.vehicleId && !loadOf.has(l.vehicleId)) loadOf.set(l.vehicleId, l);
  for (const t of trucks) {
    const fix = fixOf(t);
    const load = loadOf.get(t.id) ?? null;
    const st = classifyTractor({ engine: engineStateOf(t.engineState), speedMph: numOrNull(t.lastSpeedMph), onLoad: load != null });
    const price = numOrNull(t.costProfile?.lastFuelPricePerGallon) ?? fleetPrice;
    const minutes = st === "idling" && t.idleSince ? Math.max(0, (now.getTime() - t.idleSince.getTime()) / 60_000) : null;
    const speed = numOrNull(t.lastSpeedMph);
    const tr = trailerOf.get(t.id);
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
      driver: t.drivers[0]?.name ?? null,
      load: load ? { id: load.id, number: load.loadNumber ?? "A load", route: routeOf(load.originAddress, load.destinationAddress) } : null,
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
          select: { id: true, name: true, lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true, drivers: { where: { active: true }, select: { name: true }, take: 1, orderBy: { name: "asc" } } }
        })
      : [],
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, trailerId: { in: ids }, status: { in: OPEN_FOR_TRAILER } },
      select: { id: true, loadNumber: true, status: true, trailerId: true, originAddress: true, destinationAddress: true }
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
  const stops = await knownStopsNear(trailers.map(fixFor).filter((f): f is Fix => f != null), workspaceId, now);
  for (const t of trailers) {
    const fix = fixFor(t);
    const tractor = t.currentVehicleId ? truckOf.get(t.currentVehicleId) : undefined;
    const load = loadOf.get(t.id) ?? null;
    const d = t.currentVehicleId ? null : dwell(t.unhookedAt, now.getTime(), { freeHours: terms.dwellFreeHours, perDay: terms.dwellPerDayRate }, reloaded.has(t.id), { ratePerDay: numOrNull(t.dwellRateOverride), billableDays: numOrNull(t.dwellDaysOverride), waived: t.dwellWaived });
    const speed = tractor ? numOrNull(tractor.lastSpeedMph) : null;
    const loaded = load?.status === "in_progress";
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
      driver: tractor?.drivers[0]?.name ?? null,
      load: load ? { id: load.id, number: load.loadNumber ?? "A load", route: routeOf(load.originAddress, load.destinationAddress) } : null,
      typedPlace: t.location?.trim() || null,
      hitched: tractor ? { kind: "tractor", id: tractor.id, name: tractor.name ?? "a tractor" } : null
    });
  }
  return out;
}
