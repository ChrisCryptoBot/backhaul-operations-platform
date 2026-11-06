import { terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { equipmentCode, dwellSentence, idleLine, idleSentence } from "@/lib/radar";
import { classifyTractor, dwell, engineStateOf, fleetCounts, speedLine, type EngineState, type FleetCounts, type TractorState } from "@/lib/telematics";
import { partnerState } from "@/server/partners/call";
import { numOrNull } from "./convert";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/**
 * The radar's data: every tractor and trailer that has a position, what each is doing, and the money leaks (idle fuel, trailer dwell), read in a fixed number of queries however big the fleet is and
 * scoped to the workspace and, when one is chosen, a terminal. Plain JSON for the map and the lists. A unit with no position is not on the map but is still counted.
 */
const OPEN_LOAD = ["accepted", "in_progress"];
const OPEN_FOR_TRAILER = ["draft", "accepted", "in_progress"];

export type RadarTractor = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  headingDeg: number | null;
  speedMph: number | null;
  engine: EngineState | null;
  state: TractorState | null;
  /** "70 MPH · I-80 W". */
  road: string;
  driver: string | null;
  loadId: string | null;
  loadNumber: string | null;
  /** The trailer it pulls. A hooked trailer is where its tractor is, so it travels with the tractor and not as a unit of its own. */
  trailer: { number: string; code: string; loaded: boolean } | null;
  locatedAt: string;
  /** What standing with the engine on has cost, when it is. */
  idle: { minutes: number; gallons: number; cashLost: number | null; sentence: string; todayHours: number | null } | null;
};

export type RadarTrailer = {
  id: string;
  number: string;
  code: string;
  /** The trailer's length in feet, when it is known. */
  lengthFt: number | null;
  lat: number;
  lng: number;
  hooked: boolean;
  hookedTo: string | null;
  /** On a load that is under way. */
  loaded: boolean;
  locatedAt: string | null;
  dwell: { hours: number; alert: boolean; amount: number; waived: boolean; typed: boolean; sentence: string } | null;
};

export type RadarData = {
  tractors: RadarTractor[];
  trailers: RadarTrailer[];
  counts: FleetCounts;
  /** The newest fix, so the screen can say how old the picture is. */
  asOf: string | null;
  /** Whether an ELD is connected (else the screen says how to connect one). */
  connected: boolean;
};

export async function getRadarData(workspaceId = currentWorkspaceId(), terminal: Terminals = null, now = new Date()): Promise<RadarData> {
  const [trucks, trailers, terms, state] = await Promise.all([
    prisma.vehicle.findMany({
      where: { workspaceId, archivedAt: null, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) },
      select: {
        id: true,
        name: true,
        lastLat: true,
        lastLng: true,
        lastLocatedAt: true,
        lastSpeedMph: true,
        lastHeadingDeg: true,
        engineState: true,
        idleHoursToday: true,
        idleSince: true,
        costProfile: { select: { lastFuelPricePerGallon: true } },
        drivers: { where: { active: true }, select: { name: true }, take: 1, orderBy: { name: "asc" } }
      }
    }),
    prisma.trailer.findMany({
      where: { workspaceId, archivedAt: null, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) },
      select: { id: true, number: true, type: true, lengthFt: true, currentVehicleId: true, lastLat: true, lastLng: true, lastLocatedAt: true, unhookedAt: true, dwellRateOverride: true, dwellDaysOverride: true, dwellWaived: true }
    }),
    getThresholds(workspaceId),
    partnerState("eld", null, workspaceId)
  ]);
  const truckIds = trucks.map((t) => t.id);
  const trailerIds = trailers.map((t) => t.id);
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null, OR: [...(truckIds.length ? [{ vehicleId: { in: truckIds }, status: { in: OPEN_LOAD } }] : []), ...(trailerIds.length ? [{ trailerId: { in: trailerIds }, status: { in: OPEN_FOR_TRAILER } }] : [])] },
    select: { id: true, loadNumber: true, status: true, vehicleId: true, trailerId: true }
  });

  const loadOfTruck = new Map<string, (typeof loads)[number]>();
  for (const l of loads.filter((x) => x.vehicleId && OPEN_LOAD.includes(x.status)).sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1))) if (!loadOfTruck.has(l.vehicleId!)) loadOfTruck.set(l.vehicleId!, l);
  const trailerOfTruck = new Map(trailers.filter((t) => t.currentVehicleId).map((t) => [t.currentVehicleId!, t]));
  const reloaded = new Set(loads.filter((l) => l.trailerId).map((l) => l.trailerId!));
  const loadedTrailers = new Set(loads.filter((l) => l.trailerId && l.status === "in_progress").map((l) => l.trailerId!));
  const truckName = new Map(trucks.map((t) => [t.id, t.name ?? "a tractor"]));

  // The fleet's fuel price: a truck's own when it has one, else the average of the fleet's (never a guess when nobody has one).
  const prices = trucks.map((t) => numOrNull(t.costProfile?.lastFuelPricePerGallon)).filter((p): p is number => p != null && p > 0);
  const fleetPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const radarTractors: RadarTractor[] = [];
  const classes: Array<{ state: TractorState | null }> = [];
  for (const t of trucks) {
    const engine = engineStateOf(t.engineState);
    const speed = numOrNull(t.lastSpeedMph);
    const load = loadOfTruck.get(t.id) ?? null;
    const st = classifyTractor({ engine, speedMph: speed, onLoad: load != null });
    classes.push({ state: st });
    const lat = numOrNull(t.lastLat);
    const lng = numOrNull(t.lastLng);
    if (lat == null || lng == null || !t.lastLocatedAt) continue;
    const price = numOrNull(t.costProfile?.lastFuelPricePerGallon) ?? fleetPrice;
    const minutes = st === "idling" && t.idleSince ? Math.max(0, (now.getTime() - t.idleSince.getTime()) / 60_000) : null;
    const line = minutes != null ? idleLine(minutes, price && price > 0 ? price : null) : null;
    const trailer = trailerOfTruck.get(t.id);
    radarTractors.push({
      id: t.id,
      name: t.name ?? "Truck",
      lat,
      lng,
      headingDeg: t.lastHeadingDeg,
      speedMph: speed,
      engine,
      state: st,
      road: speedLine(speed, { lat, lng }, t.lastHeadingDeg),
      driver: t.drivers[0]?.name ?? null,
      loadId: load?.id ?? null,
      loadNumber: load?.loadNumber ?? null,
      trailer: trailer ? { number: trailer.number, code: equipmentCode(trailer.type, numOrNull(trailer.lengthFt)), loaded: loadedTrailers.has(trailer.id) } : null,
      locatedAt: t.lastLocatedAt.toISOString(),
      idle: line ? { minutes: line.minutes, gallons: line.gallons, cashLost: line.cashLost, sentence: idleSentence(line), todayHours: numOrNull(t.idleHoursToday) } : null
    });
  }

  const radarTrailers: RadarTrailer[] = [];
  for (const tr of trailers) {
    if (tr.currentVehicleId) continue; // hooked: it rides with its tractor (see `trailer` above), and the list stays small at fleet scale
    const lat = numOrNull(tr.lastLat);
    const lng = numOrNull(tr.lastLng);
    if (lat == null || lng == null) continue;
    const d = tr.currentVehicleId ? null : dwell(tr.unhookedAt, now.getTime(), { freeHours: terms.dwellFreeHours, perDay: terms.dwellPerDayRate }, reloaded.has(tr.id), { ratePerDay: numOrNull(tr.dwellRateOverride), billableDays: numOrNull(tr.dwellDaysOverride), waived: tr.dwellWaived });
    radarTrailers.push({
      id: tr.id,
      number: tr.number,
      code: equipmentCode(tr.type, numOrNull(tr.lengthFt)),
      lengthFt: numOrNull(tr.lengthFt),
      lat,
      lng,
      hooked: tr.currentVehicleId != null,
      hookedTo: tr.currentVehicleId ? (truckName.get(tr.currentVehicleId) ?? null) : null,
      loaded: loadedTrailers.has(tr.id),
      locatedAt: tr.lastLocatedAt?.toISOString() ?? null,
      dwell: d ? { hours: d.hours, alert: d.alert, amount: d.amount, waived: d.waived, typed: d.source.days === "typed" || d.source.rate === "typed" || d.waived, sentence: dwellSentence(d, terms.dwellFreeHours) } : null
    });
  }

  const newest = radarTractors.reduce<string | null>((m, t) => (m == null || t.locatedAt > m ? t.locatedAt : m), null);
  return {
    tractors: radarTractors,
    trailers: radarTrailers,
    counts: fleetCounts(classes, trailers.map((t) => ({ hooked: t.currentVehicleId != null }))),
    asOf: newest,
    connected: state.connected
  };
}
