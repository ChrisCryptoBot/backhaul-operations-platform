import { prisma } from "@/lib/db";
import { cityState } from "@/lib/city-state";
import { centralParts } from "@/lib/zoned";
import { zoneAbbr } from "@/lib/tz";
import { hhmm } from "@/lib/shifts";
import { trailOnRoad } from "@/lib/geo-line";
import { classifyTractor, engineStateOf, etaAt, geofence, roadMilesLeft, roadSchedule, speedLine, stopsAhead, type TractorState } from "@/lib/telematics";
import { fixAge } from "@/lib/whereabouts";
import { ensureRoadRoute, ensureWayThere } from "@/server/geo/road-route";
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
      /** The stretches of road the truck drove, between fixes that were on the load's road: never a straight line between two fixes. */
      driven: Array<Array<[number, number]>>;
      /** "68 MPH · I-40 E · 142 miles to destination · ETA 14:15 CT · ON SCHEDULE". */
      headline: string;
      late: boolean;
      /** One per stop the truck has been inside, in words: "GEOFENCE: AT RECEIVER FACILITY (14:12 CT)". */
      geofences: Array<{ stop: number; text: string; inside: boolean }>;
      /** The road the truck is to drive (standard car directions, kept in server memory only): the planned route through the stops, or the way there when it is off it. Null when none could be had. */
      road: { coords: Array<[number, number]>; miles: number } | null;
      /** Why miles left and the arrival are there or not: along the road; no road route to measure on; the truck on none of the roads there are. */
      roadState: "on" | "none" | "off";
      asOf: string;
    };

const OPEN = ["draft", "accepted", "in_progress", "completed"];
const WHO: Record<string, string> = { pickup: "SHIPPER", delivery: "RECEIVER" };

export async function getLoadTracking(loadId: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<LoadTracking> {
  const load = await prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, status: { in: OPEN } },
    select: {
      vehicleId: true,
      status: true,
      vehicle: { select: { name: true, lastLat: true, lastLng: true, lastLocatedAt: true, lastSpeedMph: true, lastHeadingDeg: true, engineState: true } },
      stops: { orderBy: { stopSequence: "asc" }, select: { stopSequence: true, stopRole: true, stopType: true, addressString: true, facilityName: true, lat: true, lng: true, arrivedAt: true, timeWindowLatest: true, timeWindowEarliest: true } }
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

  // The breadcrumb: the latest 500 fixes since the pickup window opened (at most three days back), ordered oldest first for drawing.
  const since = new Date(Math.max(now.getTime() - 3 * 86_400_000, (load.stops[0]?.timeWindowEarliest ?? load.stops[0]?.timeWindowLatest ?? new Date(0)).getTime() - 6 * 3_600_000));
  const latestPings = await prisma.vehiclePing.findMany({ where: { vehicleId: load.vehicleId, workspaceId, at: { gte: since } }, orderBy: { at: "desc" }, take: 500, select: { lat: true, lng: true, at: true } });
  const pings = [...latestPings].reverse();
  const trail = pings.map((p) => ({ lat: numOrNull(p.lat)!, lng: numOrNull(p.lng)! }));

  const clock = (ms: number) => `${hhmm(ms, tz)} ${zoneAbbr(tz)}`;
  const latPad = 0.02; // > 1 mile everywhere (~1.4 mi lat) so bounding box safely wraps the 1-mile geofence circle
  const firstInList = await Promise.all(
    stops.map(async (s) => {
      const cosLat = Math.max(0.25, Math.cos((s.lat * Math.PI) / 180));
      const lngPad = latPad / cosLat;
      const box = await prisma.vehiclePing.findMany({
        where: {
          vehicleId: load.vehicleId!,
          workspaceId,
          at: { gte: since },
          lat: { gte: s.lat - latPad, lte: s.lat + latPad },
          lng: { gte: s.lng - lngPad, lte: s.lng + lngPad }
        },
        orderBy: { at: "asc" },
        take: 50,
        select: { lat: true, lng: true, at: true }
      });
      return box.find((p) => geofence({ lat: numOrNull(p.lat)!, lng: numOrNull(p.lng)! }, s).inside) ?? null;
    })
  );
  const geofences: Array<{ stop: number; text: string; inside: boolean }> = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]!;
    const now_ = geofence(here, s);
    const firstIn = firstInList[i] ?? null;
    if (!now_.inside && !firstIn) continue;
    const who = WHO[s.role] ?? "STOP";
    const when = clock((firstIn?.at ?? at).getTime());
    geofences.push(now_.inside ? { stop: s.sequence, inside: true, text: `GEOFENCE: AT ${who} FACILITY (${when})` } : { stop: s.sequence, inside: false, text: `GEOFENCE: ARRIVED AT ${who} FACILITY (${when}), LEFT` });
  }

  // How much is left, on a road or not at all: the load's planned route when the truck is on it, else the road from where it is to the stops still ahead (this is a single load's own view, so
  // either may be fetched, and is kept in server memory). An old fix says where the truck was, so no arrival is worked out from it and no way there is asked for.
  const planned = await ensureRoadRoute(loadId, stops);
  const { ahead, approaching } = stopsAhead(load.status, placed.map((s) => ({ ...s, lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! })), here);
  const old = fixAge(at, now.getTime())?.old === true;
  const atDestination = geofence(here, destination).inside;
  let left = roadMilesLeft({ here, approaching, planned, way: null });
  if (!left && !old && !atDestination && load.status !== "completed") left = roadMilesLeft({ here, approaching, planned, way: await ensureWayThere(loadId, here, ahead) });
  const milesLeft = atDestination ? 0 : (left?.miles ?? null);
  const eta = atDestination || milesLeft == null || old ? null : etaAt(now.getTime(), milesLeft, speed);
  const lastWindow = load.stops[load.stops.length - 1]?.timeWindowLatest ?? null;
  const sched = roadSchedule({ here, destination, milesLeft: old ? null : milesLeft, speedMph: speed, windowLatest: lastWindow, now: now.getTime() });
  const road = left?.road ?? planned;
  const when = (ms: number) => {
    const today = centralParts(now.getTime(), tz);
    const that = centralParts(ms, tz);
    const sameDay = today.y === that.y && today.m0 === that.m0 && today.d === that.d;
    return sameDay ? clock(ms) : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(that.y, that.m0, that.d)).getUTCDay()]} ${clock(ms)}`;
  };
  const headline = [
    speedLine(speed, left?.roadName ?? null, load.vehicle.lastHeadingDeg) || null,
    atDestination ? "AT THE DESTINATION" : milesLeft != null ? `${milesLeft.toFixed(0)} miles to destination` : null,
    eta != null ? `ETA ${when(eta)}` : null,
    old ? null : sched === "late" ? "RUNNING LATE" : sched === "on_schedule" ? "ON SCHEDULE" : null
  ]
    .filter(Boolean)
    .join(" · ") || "Position read";

  return {
    status: "tracking",
    truckName,
    stops,
    position: { lat, lng, headingDeg: load.vehicle.lastHeadingDeg, at: at.toISOString(), state },
    trail,
    driven: trailOnRoad(trail, planned?.coords),
    headline,
    late: sched === "late",
    geofences,
    road: road ? { coords: road.coords.map((c) => [c[0], c[1]] as [number, number]), miles: road.miles } : null,
    roadState: left || atDestination ? "on" : planned ? "off" : "none",
    asOf: at.toISOString()
  };
}
