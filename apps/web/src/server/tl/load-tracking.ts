import { prisma } from "@/lib/db";
import { cityState } from "@/lib/city-state";
import { centralParts } from "@/lib/zoned";
import { zoneAbbr } from "@/lib/tz";
import { hhmm } from "@/lib/shifts";
import { classifyTractor, engineStateOf, etaAt, geofence, laneProgress, milesToGo, scheduleState, speedLine, type TractorState } from "@/lib/telematics";
import { haversineMiles } from "@/lib/geo";
import { numOrNull } from "./convert";
import { workspaceTimezone } from "@/server/tl/zone";
import { currentWorkspaceId } from "./workspace";

/**
 * Where a load's truck is: its lane (the stops that have a point), the truck's last fix with its speed, heading and engine, the breadcrumb of fixes since the load began, the miles and time still
 * to go, and each stop's geofence (inside a mile is "at the facility", with the time the truck first got there). Read from the ELD's fixes: the desk shows it, and writes nothing from it (a
 * stop's arrival is still what a person or the driver's phone says, because detention and money depend on it). Plain data and words, ready for the screen.
 */
export type TrackingStop = { sequence: number; role: string; label: string; lat: number; lng: number };
export type LoadTracking =
  | { status: "no_truck" }
  | { status: "no_lane"; truckName: string }
  | { status: "no_position"; truckName: string }
  | {
      status: "tracking";
      truckName: string;
      stops: TrackingStop[];
      position: { lat: number; lng: number; headingDeg: number | null; at: string; state: TractorState | null };
      trail: Array<{ lat: number; lng: number }>;
      /** "68 MPH · I-40 E · 142 miles to destination · ETA 14:15 CT · ON SCHEDULE". */
      headline: string;
      late: boolean;
      /** One per stop the truck has been inside, in words: "GEOFENCE: AT RECEIVER FACILITY (14:12 CT)". */
      geofences: Array<{ stop: number; text: string; inside: boolean }>;
      asOf: string;
    };

const OPEN = ["draft", "accepted", "in_progress", "completed"];
const WHO: Record<string, string> = { pickup: "SHIPPER", delivery: "RECEIVER" };

export async function getLoadTracking(loadId: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<LoadTracking> {
  const load = await prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, status: { in: OPEN } },
    select: {
      vehicleId: true,
      loadedMiles: true,
      vehicle: { select: { name: true, lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true } },
      stops: { orderBy: { stopSequence: "asc" }, select: { stopSequence: true, stopRole: true, stopType: true, addressString: true, facilityName: true, lat: true, lng: true, timeWindowLatest: true, timeWindowEarliest: true } }
    }
  });
  if (!load || !load.vehicleId || !load.vehicle) return { status: "no_truck" };
  const truckName = load.vehicle.name ?? "The truck";
  const placed = load.stops.filter((s) => s.lat != null && s.lng != null);
  if (placed.length < 2) return { status: "no_lane", truckName };
  const lat = numOrNull(load.vehicle.lastLat);
  const lng = numOrNull(load.vehicle.lastLng);
  if (lat == null || lng == null || !load.vehicle.lastLocatedAt) return { status: "no_position", truckName };

  const tz = await workspaceTimezone(workspaceId);
  const stops: TrackingStop[] = placed.map((s) => ({ sequence: s.stopSequence, role: s.stopRole ?? s.stopType, label: s.facilityName ?? cityState(s.addressString) ?? "Stop", lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! }));
  const origin = stops[0]!;
  const destination = stops[stops.length - 1]!;
  const speed = numOrNull(load.vehicle.lastSpeedMph);
  const here = { lat, lng };
  const at = load.vehicle.lastLocatedAt;
  const state = classifyTractor({ engine: engineStateOf(load.vehicle.engineState), speedMph: speed, onLoad: true });

  // The breadcrumb: the fixes since the pickup window opened (at most three days back), oldest first.
  const since = new Date(Math.max(now.getTime() - 3 * 86_400_000, (load.stops[0]?.timeWindowEarliest ?? load.stops[0]?.timeWindowLatest ?? new Date(0)).getTime() - 6 * 3_600_000));
  const pings = await prisma.vehiclePing.findMany({ where: { vehicleId: load.vehicleId, workspaceId, at: { gte: since } }, orderBy: { at: "asc" }, take: 500, select: { lat: true, lng: true, at: true } });
  const trail = pings.map((p) => ({ lat: numOrNull(p.lat)!, lng: numOrNull(p.lng)! }));

  const clock = (ms: number) => `${hhmm(ms, tz)} ${zoneAbbr(tz)}`;
  const geofences: Array<{ stop: number; text: string; inside: boolean }> = [];
  for (const s of stops) {
    const now_ = geofence(here, s);
    const firstIn = pings.find((p) => geofence({ lat: numOrNull(p.lat)!, lng: numOrNull(p.lng)! }, s).inside);
    if (!now_.inside && !firstIn) continue;
    const who = WHO[s.role] ?? "STOP";
    const when = clock((firstIn?.at ?? at).getTime());
    geofences.push(now_.inside ? { stop: s.sequence, inside: true, text: `GEOFENCE: AT ${who} FACILITY (${when})` } : { stop: s.sequence, inside: false, text: `GEOFENCE: ARRIVED AT ${who} FACILITY (${when}), LEFT` });
  }

  // How far along the lane, and what is left: the load's own loaded miles when it has them.
  const lane = laneProgress(origin, destination, here);
  const straight = haversineMiles(origin, destination);
  const atDestination = geofence(here, destination).inside;
  const toGo = atDestination ? 0 : milesToGo(lane.fraction, numOrNull(load.loadedMiles), straight);
  const eta = atDestination ? null : etaAt(now.getTime(), toGo, speed);
  const lastWindow = load.stops[load.stops.length - 1]?.timeWindowLatest ?? null;
  const sched = eta == null ? null : scheduleState(eta, lastWindow);
  const when = (ms: number) => {
    const today = centralParts(now.getTime(), tz);
    const that = centralParts(ms, tz);
    const sameDay = today.y === that.y && today.m0 === that.m0 && today.d === that.d;
    return sameDay ? clock(ms) : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(that.y, that.m0, that.d)).getUTCDay()]} ${clock(ms)}`;
  };
  const headline = [
    speedLine(speed, here, load.vehicle.lastHeadingDeg) || null,
    atDestination ? "AT THE DESTINATION" : `${toGo.toFixed(0)} miles to destination`,
    eta != null ? `ETA ${when(eta)}` : null,
    sched === "late" ? "RUNNING LATE" : sched === "on_schedule" ? "ON SCHEDULE" : null
  ]
    .filter(Boolean)
    .join(" · ");

  return { status: "tracking", truckName, stops, position: { lat, lng, headingDeg: load.vehicle.lastHeadingDeg, at: at.toISOString(), state }, trail, headline, late: sched === "late", geofences, asOf: at.toISOString() };
}
