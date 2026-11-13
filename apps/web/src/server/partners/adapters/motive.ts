import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import { bearingDeg, interpolate } from "@/lib/geo-line";
import { CA_PROVINCES, placeParts, stateCode, US_STATES } from "@/lib/fuel-normalize";
import type { AdapterShapes, EldIftaIn, EldStatusIn, IftaMilePiece, IftaTripHint, SimTrip } from "../call";
import { notImplemented } from "../not-implemented";
import { CORRIDORS } from "./promiles";
import { seedOf } from "./sandbox";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * ELD and telematics, modeled after Motive. The shapes below are what the desk ASSUMES a Motive-style API answers (vehicle positions, and each driver's remaining clocks in seconds); they are
 * modeled on how that product is described, not taken from its documentation, because we have no keys or docs yet. When we do, the only things to check are these two payload types and the two
 * methods of the live client: the normalizer, the adapter and the simulator all hang off them.
 */
export type MotiveLocations = {
  vehicle_locations: Array<{
    vehicle_location: {
      id: number;
      located_at: string;
      lat: number;
      lon: number;
      speed: number | null;
      bearing: number | null;
      /** The engine at that fix, how many seconds it has idled today, and how long it has been standing with the engine on. Assumed, like the rest of this shape. */
      engine_state?: "moving" | "idling" | "off" | null;
      idle_time_s?: number | null;
      stopped_for_s?: number | null;
      vehicle: { id: number; number: string; vin?: string | null };
      current_driver: { id: number; first_name: string; last_name: string } | null;
    };
  }>;
};

/** The company's whole fleet and roster, as a first read of a new account would list them. */
export type MotiveRoster = {
  vehicles: Array<{ id: number; number: string; vin: string | null; make: string | null; model: string | null; year: number | null }>;
  users: Array<{ id: number; first_name: string; last_name: string; license_number: string | null; /** The vehicle the company has the driver assigned to. */ vehicle_id?: number | null }>;
};

export type MotiveHos = {
  users: Array<{
    user: { id: number; first_name: string; last_name: string };
    /** Seconds left on each clock. */
    hos_availability: { drive_remaining: number; shift_remaining: number; cycle_remaining: number; break_remaining: number };
  }>;
};

/**
 * The IFTA trips report (money plan Wave 5 step 5a): what each vehicle drove in each jurisdiction over a date range, one entry per piece, with the odometer at each end. ASSUMED like the shapes
 * above (modeled on how Motive describes its IFTA reports, not on its documentation): miles, not kilometres; times ISO; one entry per vehicle, jurisdiction and stretch of road. The company does
 * not know the desk's loads; the normalizer ties a piece to a load by time.
 */
export type MotiveIftaTrips = {
  ifta_trips: Array<{
    ifta_trip: {
      id: number | string;
      /** The day the piece began (YYYY-MM-DD). */
      date: string;
      /** Two-letter state or province. */
      jurisdiction: string;
      vehicle: { id: number; number: string };
      start_time: string;
      end_time: string;
      start_odometer: number;
      end_odometer: number;
      /** Miles driven in the piece. */
      distance: number;
    };
  }>;
};

export interface MotiveClient {
  vehicleLocations(): Promise<MotiveLocations>;
  hosAvailability(): Promise<MotiveHos>;
  fleetRoster(): Promise<MotiveRoster>;
  /** The IFTA trips report for these vehicles over these days (inclusive, the company's calendar days). */
  iftaTrips(query: { start_date: string; end_date: string; vehicle_ids: number[] }): Promise<MotiveIftaTrips>;
}

type In = EldStatusIn;
type Out = AdapterShapes["eld"]["out"];
type IftaOut = NonNullable<Out["iftaTrips"]>;

/** The live client. No company is wired and no network is opened: both calls say so. */
export const liveMotiveClient: MotiveClient = {
  async vehicleLocations() {
    throw new NotLive();
  },
  async hosAvailability() {
    throw new NotLive();
  },
  async fleetRoster() {
    throw new NotLive();
  },
  async iftaTrips() {
    throw new NotLive();
  }
};

const whole = (n: number) => n - (n % 1);
const minutesOf = (seconds: number) => whole(Math.max(0, seconds) / 60);
const hoursOf = (minutes: number) => new Prisma.Decimal(minutes).div(60).toDecimalPlaces(2).toNumber();
const engineOf = (s: "moving" | "idling" | "off" | null | undefined): "moving" | "idle" | "off" | null => (s === "moving" ? "moving" : s === "idling" ? "idle" : s === "off" ? "off" : null);
const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim().toLowerCase();

/**
 * The company's shapes into the desk's. A desk truck is matched to the company's vehicle by the id it was linked with, else by name ("Unit 101"); a desk driver to the company's user by the id,
 * else by full name. What is not matched is left out, never guessed. A tractor's "hours available" is what its current driver has left to drive and to work, whichever is less.
 */
export function normalizeMotive(input: In, locations: MotiveLocations, hos: MotiveHos): Out {
  const usersById = new Map(hos.users.map((u) => [String(u.user.id), u]));
  const usersByName = new Map(hos.users.map((u) => [fullName(u.user), u]));
  const places = locations.vehicle_locations.map((l) => l.vehicle_location);

  const vehicles = input.vehicles.flatMap((truck) => {
    const place = places.find((p) => (truck.eldVehicleId != null && String(p.vehicle.id) === truck.eldVehicleId) || (truck.name != null && p.vehicle.number.trim().toLowerCase() === truck.name.trim().toLowerCase()));
    if (!place) return [];
    const clocks = place.current_driver ? usersById.get(String(place.current_driver.id))?.hos_availability : undefined;
    return [
      {
        id: truck.id,
        eldVehicleId: String(place.vehicle.id),
        hosAvailableHours: clocks ? hoursOf(Math.min(minutesOf(clocks.drive_remaining), minutesOf(clocks.shift_remaining))) : null,
        location: { lat: place.lat, lng: place.lon, at: place.located_at },
        // Speed and heading were always in the payload; they are kept now, with the engine and the idle time.
        speedMph: place.speed ?? null,
        headingDeg: place.bearing ?? null,
        engine: engineOf(place.engine_state),
        idleHoursToday: place.idle_time_s != null ? hoursOf(minutesOf(place.idle_time_s)) : null,
        idleMinutes: place.engine_state === "idling" && place.stopped_for_s != null ? minutesOf(place.stopped_for_s) : null,
        vin: place.vehicle.vin ?? null
      }
    ];
  });

  const drivers = (input.drivers ?? []).flatMap((d) => {
    const row = (d.eldDriverId != null ? usersById.get(d.eldDriverId) : undefined) ?? usersByName.get(d.name.trim().toLowerCase());
    if (!row) return [];
    return [{ id: d.id, eldDriverId: String(row.user.id), driveMinutes: minutesOf(row.hos_availability.drive_remaining), shiftMinutes: minutesOf(row.hos_availability.shift_remaining), cycleMinutes: minutesOf(row.hos_availability.cycle_remaining) }];
  });

  return { vehicles, drivers };
}

/** The company's whole fleet and roster in the desk's words, with each driver's clocks. */
export function normalizeRoster(roster: MotiveRoster, hos: MotiveHos): NonNullable<Out["roster"]> {
  const clocks = new Map(hos.users.map((u) => [u.user.id, u.hos_availability]));
  return {
    vehicles: roster.vehicles.map((v) => ({ eldVehicleId: String(v.id), number: v.number, vin: v.vin, make: v.make, model: v.model, year: v.year })),
    drivers: roster.users.map((u) => {
      const c = clocks.get(u.id);
      return { eldDriverId: String(u.id), name: `${u.first_name} ${u.last_name}`.trim(), licenseNumber: u.license_number, eldVehicleId: u.vehicle_id != null ? String(u.vehicle_id) : null, driveMinutes: c ? minutesOf(c.drive_remaining) : 0, shiftMinutes: c ? minutesOf(c.shift_remaining) : 0, cycleMinutes: c ? minutesOf(c.cycle_remaining) : 0 };
    })
  };
}

/** A tenth of a mile, exact: odometers and miles are kept to one place. */
const tenth = (n: number | string) => new Prisma.Decimal(n).toDecimalPlaces(1);
const isoTime = (s: string) => {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
};

/** The load a piece was driven on: the load whose pickup-to-delivery window holds the middle of the piece. None means the truck was empty. */
export function loadOfPiece(hints: readonly IftaTripHint[], startedAt: number, endedAt: number): string | null {
  const mid = startedAt + (endedAt - startedAt) / 2;
  const on = hints.filter((h) => h.pickupAt <= mid && mid < h.deliveredAt).sort((a, b) => a.pickupAt - b.pickupAt || a.loadId.localeCompare(b.loadId));
  return on[0]?.loadId ?? null;
}

/**
 * The company's IFTA trips into the desk's pieces. A company vehicle is matched to a desk truck by the id it was linked with, else by name, and one desk truck takes one company vehicle (a second
 * vehicle with the same name is left out, never added to the first). Then, piece by piece:
 *   - a piece belongs to the quarter it STARTS in: one that starts before `from` or at/after `to` is left out (outsideQuarter), so a piece over the boundary is counted once, in its first quarter;
 *   - one that ends after the desk's clock is left out (afterAsOf): the desk does not take what it could not have been told yet;
 *   - an unknown jurisdiction, an unreadable time, an odometer that runs backwards or a negative distance is left out (unreadable), never guessed;
 *   - the same piece twice (company id and jurisdiction) is kept once (duplicate);
 *   - a Canadian province is counted for the truck and not kept (gap 15).
 * A desk truck the company reported any piece for is "answered", whatever was left out of it. Miles and odometers are exact to a tenth.
 */
export function normalizeMotiveIfta(input: EldIftaIn, answer: MotiveIftaTrips): IftaOut {
  const from = isoTime(input.from) ?? 0;
  const to = isoTime(input.to) ?? 0;
  const byEld = new Map<string, EldIftaIn["vehicles"][number]>();
  for (const t of input.vehicles) if (t.eldVehicleId != null && !byEld.has(t.eldVehicleId)) byEld.set(t.eldVehicleId, t);
  const claimed = new Map<string, string>(); // desk truck -> company vehicle id
  const truckOf = (v: { id: number; number: string }) => {
    const id = String(v.id);
    const linked = byEld.get(id);
    const truck = linked ?? input.vehicles.find((t) => t.eldVehicleId == null && t.name != null && t.name.trim().toLowerCase() === v.number.trim().toLowerCase());
    if (!truck) return null;
    const had = claimed.get(truck.id);
    if (had != null && had !== id) return null;
    claimed.set(truck.id, id);
    return truck;
  };

  const pieces: IftaMilePiece[] = [];
  const canada: IftaOut["canada"] = [];
  const answered = new Set<string>();
  const seen = new Set<string>();
  const skipped = { outsideQuarter: 0, afterAsOf: 0, unreadable: 0, duplicate: 0 };
  for (const { ifta_trip: p } of answer.ifta_trips) {
    const truck = truckOf(p.vehicle);
    if (!truck) continue;
    answered.add(truck.id);
    const code = stateCode(p.jurisdiction);
    const s = isoTime(p.start_time);
    const e = isoTime(p.end_time);
    if (!code || s == null || e == null || e < s || !Number.isFinite(p.start_odometer) || !Number.isFinite(p.end_odometer) || !Number.isFinite(p.distance) || p.distance < 0 || p.end_odometer < p.start_odometer) {
      skipped.unreadable += 1;
      continue;
    }
    if (s < from || s >= to) {
      skipped.outsideQuarter += 1;
      continue;
    }
    if (e > input.asOf) {
      skipped.afterAsOf += 1;
      continue;
    }
    const externalId = `${String(p.id)}:${code}`;
    if (seen.has(externalId)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(externalId);
    const miles = tenth(p.distance);
    if (CA_PROVINCES[code] != null) {
      canada.push({ vehicleId: truck.id, jurisdiction: code, miles: miles.toFixed(1) });
      continue;
    }
    if (US_STATES[code] == null) {
      skipped.unreadable += 1;
      continue;
    }
    const loadId = loadOfPiece(truck.trips ?? [], s, e);
    pieces.push({
      vehicleId: truck.id,
      externalId,
      jurisdiction: code,
      loaded: loadId != null,
      loadId,
      startOdometer: tenth(p.start_odometer).toFixed(1),
      endOdometer: tenth(p.end_odometer).toFixed(1),
      miles: miles.toFixed(1),
      startedAt: new Date(s).toISOString(),
      endedAt: new Date(e).toISOString()
    });
  }
  pieces.sort((a, b) => a.vehicleId.localeCompare(b.vehicleId) || a.startedAt.localeCompare(b.startedAt) || a.externalId.localeCompare(b.externalId));
  return { pieces, answered: [...answered].sort(), canada, skipped };
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/** Places a tractor can be, so a simulated fleet is spread over real freight lanes. */
export const SANDBOX_HUBS: ReadonlyArray<{ city: string; lat: number; lng: number }> = [
  { city: "Dallas, TX", lat: 32.7767, lng: -96.797 },
  { city: "Atlanta, GA", lat: 33.749, lng: -84.388 },
  { city: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  { city: "Memphis, TN", lat: 35.1495, lng: -90.049 },
  { city: "Kansas City, MO", lat: 39.0997, lng: -94.5786 },
  { city: "Houston, TX", lat: 29.7604, lng: -95.3698 },
  { city: "Columbus, OH", lat: 39.9612, lng: -82.9988 },
  { city: "Nashville, TN", lat: 36.1627, lng: -86.7816 },
  { city: "Indianapolis, IN", lat: 39.7684, lng: -86.1581 },
  { city: "Denver, CO", lat: 39.7392, lng: -104.9903 },
  { city: "Phoenix, AZ", lat: 33.4484, lng: -112.074 },
  { city: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 }
];

const QUARTER_HOUR = 15 * 60_000;
const bucket = (now: Date) => (now.getTime() - (now.getTime() % QUARTER_HOUR)) / QUARTER_HOUR;
/** 0..1 from a seed and a salt, stable. */
const unit = (seed: number, salt: number) => seedOf(`${seed}:${salt}`) / 0xffffffff;

const HOUR = 3_600_000;
const r6 = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(6).toNumber();

/**
 * The company's own fleet in the simulator: what a first read of a new account would list (units, VINs, make and model, and the people who drive them), each truck on a lane between two freight
 * hubs. A desk that enters a test key gets these as its trucks and drivers (server/partners/eld-import.ts), already on the map.
 */
export const SANDBOX_FLEET: ReadonlyArray<{ id: number; number: string; vin: string; make: string; model: string; year: number; lane: [number, number]; driver: { id: number; first: string; last: string; license: string } }> = [
  { id: 910301, number: "Unit 301", vin: "1FUJGHDV3NLAB3011", make: "Freightliner", model: "Cascadia", year: 2022, lane: [0, 1], driver: { id: 70301, first: "Marcus", last: "Webb", license: "TX-41782930" } },
  { id: 910302, number: "Unit 302", vin: "1XKYD49X4MJ4A3022", make: "Kenworth", model: "T680", year: 2021, lane: [2, 3], driver: { id: 70302, first: "Priya", last: "Nair", license: "IL-N6204417" } },
  { id: 910303, number: "Unit 303", vin: "1XPBD49X8PD5B3033", make: "Peterbilt", model: "579", year: 2023, lane: [4, 5], driver: { id: 70303, first: "Luis", last: "Ortega", license: "MO-93510284" } },
  { id: 910304, number: "Unit 304", vin: "4V4NC9EH5NN6C3044", make: "Volvo", model: "VNL 860", year: 2022, lane: [6, 7], driver: { id: 70304, first: "Dana", last: "Whitfield", license: "OH-RG481927" } },
  { id: 910305, number: "Unit 305", vin: "3HSDJAPR1MN7D3055", make: "International", model: "LT625", year: 2021, lane: [8, 9], driver: { id: 70305, first: "Terrence", last: "Boyd", license: "IN-1129384756" } },
  { id: 910306, number: "Unit 306", vin: "1FUJGHDV7LLM83066", make: "Freightliner", model: "Cascadia", year: 2020, lane: [10, 11], driver: { id: 70306, first: "Hannah", last: "Kowalski", license: "AZ-D08265531" } },
  { id: 910307, number: "Unit 307", vin: "1XKWD40X1PJ9F3077", make: "Kenworth", model: "W990", year: 2023, lane: [5, 0], driver: { id: 70307, first: "Omar", last: "Haddad", license: "TX-52807716" } },
  { id: 910308, number: "Unit 308", vin: "1M1AN4GY6NM0G3088", make: "Mack", model: "Anthem", year: 2022, lane: [1, 6], driver: { id: 70308, first: "Grace", last: "Lindqvist", license: "GA-040918265" } }
];

type Sim = { lat: number; lng: number; speed: number; bearing: number | null; engine: "moving" | "idling" | "off"; idleTodayS: number; stoppedForS: number | null };

const hubPoint = (i: number) => ({ lat: SANDBOX_HUBS[i % SANDBOX_HUBS.length]!.lat, lng: SANDBOX_HUBS[i % SANDBOX_HUBS.length]!.lng });

/** The share of the carrier's day gone, the way the clocks already use it. */
const dayShare = (now: number) => {
  const d = new Date(now);
  return ((d.getUTCHours() * 60 + d.getUTCMinutes() + 18 * 60) % 1440) / 1440;
};

/** Standing at a place: engine off, or (in a stable third of six-hour blocks) idling since part way into the block. A parked fix drifts a few yards each quarter hour, as a real one does. */
function standing(seed: number, now: number, q: number, at: { lat: number; lng: number }): Sim {
  const block = whole(now / (6 * HOUR));
  const began = block * 6 * HOUR + whole(unit(seed, block + 700) * 2 * HOUR);
  const idling = unit(seed, block + 500) < 0.35 && now >= began;
  const stopped = idling ? whole((now - began) / 1000) : null;
  const base = 0.3 + unit(seed, 11) * 2.5;
  const idleHours = base * dayShare(now) + (stopped ?? 0) / 3600;
  return { lat: r6(at.lat + (unit(seed, q + 3) - 0.5) * 0.0008), lng: r6(at.lng + (unit(seed, q + 4) - 0.5) * 0.0008), speed: 0, bearing: null, engine: idling ? "idling" : "off", idleTodayS: whole(idleHours * 3600), stoppedForS: stopped };
}

/** Under way between two places: the lane's own heading, a plausible speed, and now and then a short stop with the engine running. */
function underWay(seedKey: string, seed: number, now: number, q: number, from: { lat: number; lng: number }, to: { lat: number; lng: number }, f: number): Sim {
  const p = interpolate(from, to, f);
  if (unit(seed, q + 6) < 0.06) return { ...standing(seed, now, q, p), engine: "idling", stoppedForS: 900, idleTodayS: whole((0.2 + unit(seed, 12)) * 3600) };
  return { lat: r6(p.lat), lng: r6(p.lng), speed: 45 + (seedOf(`${seedKey}:s:${q}`) % 22), bearing: bearingDeg(from, to), engine: "moving", idleTodayS: whole((0.1 + unit(seed, 12) * 1.4) * dayShare(now) * 3600), stoppedForS: null };
}

/**
 * Where a simulated tractor is and what its engine is doing, from what the desk knows of it: on its load's lane (by the clock, or somewhere on the road for a load already under way), on the lane
 * of the company fleet it belongs to, or parked at its home base. Stable for a quarter hour, so the same truck at the same moment always answers the same.
 */
function simulateTractor(truck: In["vehicles"][number], fleet: (typeof SANDBOX_FLEET)[number] | null, now: number, q: number, seed: number): Sim {
  const nowQ = q * QUARTER_HOUR;
  const trip: SimTrip | null | undefined = truck.trip;
  if (trip) {
    const span = Math.max(trip.endsAt - trip.startsAt, HOUR);
    let f = (nowQ - trip.startsAt) / span;
    if (trip.inProgress && (f <= 0 || f >= 1)) {
      // A load already on the road is somewhere along its lane whatever its window says: round the lane once a day and a half, resting at the receiver for the last stretch of the circuit.
      const cycle = ((nowQ / HOUR + unit(seed, 21) * 36) % 36) / 36;
      f = Math.min(1, 0.1 + cycle * 0.95);
    }
    if (f <= 0) return standing(seed, now, q, trip.origin);
    if (f >= 1) return standing(seed, now, q, trip.destination);
    return underWay(truck.id, seed, now, q, trip.origin, trip.destination, f);
  }
  if (fleet) {
    const a = hubPoint(fleet.lane[0]);
    const b = hubPoint(fleet.lane[1]);
    const c = ((nowQ / HOUR + (fleet.id % 7) * 2.3) % 20) / 20;
    if (c < 0.1) return standing(seed, now, q, a);
    if (c > 0.9) return standing(seed, now, q, b);
    return underWay(truck.id, seed, now, q, a, b, (c - 0.1) / 0.8);
  }
  const home = truck.home ?? hubPoint(seedOf(`${truck.id}:hub`));
  return standing(seed, now, q, home);
}

/** The company's own vehicle for a desk truck, matched the way the normalizer matches (its id, else its name). */
const fleetOf = (truck: { name: string | null; eldVehicleId: string | null }) => SANDBOX_FLEET.find((f) => (truck.eldVehicleId != null && String(f.id) === truck.eldVehicleId) || (truck.name != null && f.number.toLowerCase() === truck.name.trim().toLowerCase())) ?? null;

/** The company's id for a simulated desk truck: the fleet vehicle it is, else the numeric id it was linked with, else a stable number from the truck. */
const simVehicleId = (truck: { id: string; name: string | null; eldVehicleId: string | null }) => {
  const fleet = fleetOf(truck);
  return fleet ? fleet.id : truck.eldVehicleId && /^\d+$/.test(truck.eldVehicleId) ? parseInt(truck.eldVehicleId, 10) : 10_000 + (seedOf(truck.id) % 89_999);
};

/**
 * A simulated fleet, in the company's shapes: one vehicle per desk truck (the company's id is stable for a truck), placed at a hub that changes every six hours with a little drift each quarter
 * hour, and each driver's clocks consumed in proportion to the time of day. The same truck at the same quarter hour always answers the same, so a test can pin it.
 */
export function sandboxMotivePayloads(input: In, now: Date): { locations: MotiveLocations; hos: MotiveHos } {
  const driverOfTruck = new Map((input.drivers ?? []).filter((d) => d.vehicleId).map((d) => [d.vehicleId!, d]));
  const q = bucket(now);
  const users = new Map<number, MotiveHos["users"][number]>();

  const vehicle_locations = input.vehicles.map((truck) => {
    const seed = seedOf(truck.id);
    const fleet = fleetOf(truck);
    const vehicleId = simVehicleId(truck);
    const sim = simulateTractor(truck, fleet, now.getTime(), q, seed);
    const desk = driverOfTruck.get(truck.id);
    let current_driver: MotiveLocations["vehicle_locations"][number]["vehicle_location"]["current_driver"] = null;
    if (desk) {
      const [first = "", ...rest] = desk.name.trim().split(/\s+/);
      const userId = desk.eldDriverId && /^\d+$/.test(desk.eldDriverId) ? parseInt(desk.eldDriverId, 10) : 50_000 + (seedOf(desk.id) % 49_999);
      current_driver = { id: userId, first_name: first, last_name: rest.join(" ") };
      // Clocks: eleven hours of driving, fourteen on duty, seventy in the cycle, less what the day has used (a stable share per driver, a little more as the day goes on).
      const used = 0.15 + unit(seedOf(desk.id), 7) * 0.7;
      const day = ((now.getUTCHours() * 60 + now.getUTCMinutes() + 18 * 60) % 1440) / 1440;
      const burn = Math.min(0.95, used * (0.6 + day * 0.8));
      const cycleUsed = 0.2 + unit(seedOf(desk.id), 9) * 0.6;
      /** Whole minutes, in seconds: the company reports clocks that way, and a clock never reads below its floor. */
      const clock = (total: number, share: number, floor: number) => {
        const left = Math.max(floor, total - share * total);
        return left - (left % 60);
      };
      users.set(userId, {
        user: { id: userId, first_name: first, last_name: rest.join(" ") },
        hos_availability: { drive_remaining: clock(11 * 3600, burn, 600), shift_remaining: clock(14 * 3600, burn * 0.86, 900), cycle_remaining: clock(70 * 3600, cycleUsed, 3600), break_remaining: 8 * 3600 }
      });
    }
    return {
      vehicle_location: {
        id: vehicleId * 1000 + (q % 1000),
        located_at: new Date(now.getTime() - (seedOf(`${truck.id}:${q}`) % 5) * 60_000).toISOString(),
        lat: sim.lat,
        lon: sim.lng,
        speed: sim.speed,
        bearing: sim.bearing ?? seedOf(`${truck.id}:b:${q}`) % 360,
        engine_state: sim.engine,
        idle_time_s: sim.idleTodayS,
        stopped_for_s: sim.stoppedForS,
        vehicle: { id: vehicleId, number: truck.name ?? `Truck ${vehicleId}`, ...(fleet ? { vin: fleet.vin } : {}) },
        current_driver
      }
    };
  });

  // The company's own roster, for the one-click import: every fleet driver has clocks.
  if (input.discover) {
    for (const f of SANDBOX_FLEET) {
      if (users.has(f.driver.id)) continue;
      const used = 0.15 + unit(f.driver.id, 7) * 0.5;
      users.set(f.driver.id, { user: { id: f.driver.id, first_name: f.driver.first, last_name: f.driver.last }, hos_availability: { drive_remaining: whole((11 - used * 11) * 60) * 60, shift_remaining: whole((14 - used * 12) * 60) * 60, cycle_remaining: whole((50 - used * 20) * 60) * 60, break_remaining: 8 * 3600 } });
    }
  }
  // A driver on no truck still has clocks (the company knows every driver it has an account for).
  for (const d of input.drivers ?? []) {
    const [first = "", ...rest] = d.name.trim().split(/\s+/);
    const userId = d.eldDriverId && /^\d+$/.test(d.eldDriverId) ? parseInt(d.eldDriverId, 10) : 50_000 + (seedOf(d.id) % 49_999);
    if (users.has(userId)) continue;
    users.set(userId, { user: { id: userId, first_name: first, last_name: rest.join(" ") }, hos_availability: { drive_remaining: 11 * 3600, shift_remaining: 14 * 3600, cycle_remaining: 60 * 3600, break_remaining: 8 * 3600 } });
  }
  return { locations: { vehicle_locations }, hos: { users: [...users.values()] } };
}

/** The simulated company's whole fleet and roster. */
export function sandboxMotiveRoster(): MotiveRoster {
  return {
    vehicles: SANDBOX_FLEET.map((f) => ({ id: f.id, number: f.number, vin: f.vin, make: f.make, model: f.model, year: f.year })),
    users: SANDBOX_FLEET.map((f) => ({ id: f.driver.id, first_name: f.driver.first, last_name: f.driver.last, license_number: f.driver.license, vehicle_id: f.id }))
  };
}


// ── The simulator: a quarter's IFTA trips ────────────────────────────────────────────────────

/** The simulated tractor's speed between places, for the time an empty run takes. */
const SIM_MPH = 50;
const durationOf = (miles: Prisma.Decimal) => whole(miles.div(SIM_MPH).times(HOUR).toNumber());

/** The states a run passes through and each one's share, from ProMiles' simulated corridors (the same lanes, either way round), else half each end; a run inside one state is all that state's. */
function runShares(from: string | null, to: string | null): Array<[string, number]> {
  const a = placeParts(from).state ?? placeParts(to).state;
  const b = placeParts(to).state ?? a;
  if (!a || !b) return [];
  if (a === b) return [[a, 1]];
  const fwd = CORRIDORS[`${a}>${b}`];
  if (fwd) return fwd;
  const back = CORRIDORS[`${b}>${a}`];
  if (back) return [...back].reverse();
  return [[a, 0.5], [b, 0.5]];
}

type SimRun = { key: string; from: string | null; to: string | null; miles: Prisma.Decimal; start: number; end: number };

/** The odometer a simulated truck starts the quarter's runs at: stable for a truck and a quarter, and a quarter later reads further on. */
function startOdometer(truckId: string, quarter: string): Prisma.Decimal {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  const index = m ? (parseInt(m[1]!, 10) * 4 + parseInt(m[2]!, 10)) % 40 : 0;
  return new Prisma.Decimal(100_000 + (seedOf(`${truckId}:odo`) % 200_000) + index * 30_000);
}

/**
 * A simulated IFTA trips report, in the company's shapes, from the trip hints the desk passes: for each truck, the empty run to each pickup (from the last delivery, or home), the loaded run, and
 * the run home after the last delivery. Each run is split over the states its lane passes through, its miles exact to a tenth (the last state takes the rest, so a run's pieces add up to it) and
 * its time shared out by miles; the odometer runs on piece to piece. Only what overlaps the asked days and was done by `asOf` is reported. Deterministic: the same input answers the same, and it
 * never reads the wall clock (the adapter refuses a call without `asOf`).
 */
export function sandboxMotiveIftaTrips(input: EldIftaIn): MotiveIftaTrips {
  const from = new Date(input.from).getTime();
  const to = new Date(input.to).getTime();
  const out: MotiveIftaTrips["ifta_trips"] = [];
  for (const truck of input.vehicles) {
    const hints = [...(truck.trips ?? [])].sort((a, b) => a.pickupAt - b.pickupAt || a.loadId.localeCompare(b.loadId));
    if (hints.length === 0) continue;
    const vehicleId = simVehicleId(truck);
    const runs: SimRun[] = [];
    let place: string | null = truck.home ?? null;
    let lastEnd: number | null = null;
    for (const h of hints) {
      const empty = tenth(h.pickupDeadheadMiles);
      if (empty.gt(0)) {
        let start = h.pickupAt - durationOf(empty);
        if (lastEnd != null && start < lastEnd) start = lastEnd;
        if (start >= h.pickupAt) start = h.pickupAt - 60_000;
        runs.push({ key: `e-${h.loadId}`, from: place ?? h.origin, to: h.origin, miles: empty, start, end: h.pickupAt });
      }
      const loaded = tenth(h.loadedMiles);
      if (loaded.gt(0) && h.deliveredAt > h.pickupAt) runs.push({ key: `l-${h.loadId}`, from: h.origin, to: h.destination, miles: loaded, start: h.pickupAt, end: h.deliveredAt });
      place = h.destination;
      lastEnd = h.deliveredAt;
    }
    const last = hints[hints.length - 1]!;
    const home = tenth(last.returnDeadheadMiles);
    if (home.gt(0)) runs.push({ key: `r-${last.loadId}`, from: last.destination, to: truck.home ?? last.destination, miles: home, start: last.deliveredAt, end: last.deliveredAt + durationOf(home) });

    let odometer = startOdometer(truck.id, input.quarter);
    for (const run of runs) {
      const shares = runShares(run.from, run.to);
      let done = new Prisma.Decimal(0);
      for (const [i, [state, share]] of shares.entries()) {
        const miles = i === shares.length - 1 ? run.miles.minus(done) : run.miles.times(share).toDecimalPlaces(1, Prisma.Decimal.ROUND_DOWN);
        const at = (d: Prisma.Decimal) => run.start + whole(d.div(run.miles).times(run.end - run.start).toNumber());
        const start = at(done);
        const end = i === shares.length - 1 ? run.end : at(done.plus(miles));
        const startOdo = odometer;
        odometer = odometer.plus(miles);
        done = done.plus(miles);
        if (end <= from || start >= to || end > input.asOf) continue;
        out.push({
          ifta_trip: {
            id: `sim-${vehicleId}-${run.key}-${i}`,
            date: new Date(start).toISOString().slice(0, 10),
            jurisdiction: state,
            vehicle: { id: vehicleId, number: truck.name ?? `Truck ${vehicleId}` },
            start_time: new Date(start).toISOString(),
            end_time: new Date(end).toISOString(),
            start_odometer: startOdo.toNumber(),
            end_odometer: odometer.toNumber(),
            distance: miles.toNumber()
          }
        });
      }
    }
  }
  return { ifta_trips: out };
}

/** The simulator as a client: the company's calls, answered from `sandboxMotivePayloads`. A status read carries no trip hints, so its IFTA report has nothing driven. */
export function sandboxMotiveClient(input: In, now: Date = new Date()): MotiveClient {
  const p = sandboxMotivePayloads(input, now);
  return { vehicleLocations: async () => p.locations, hosAvailability: async () => p.hos, fleetRoster: async () => sandboxMotiveRoster(), iftaTrips: async () => ({ ifta_trips: [] }) };
}

/** The simulator as a client for a quarter's miles: the IFTA report from `sandboxMotiveIftaTrips`, at the desk's clock only. */
export function sandboxMotiveIftaClient(input: EldIftaIn): MotiveClient {
  return { vehicleLocations: async () => ({ vehicle_locations: [] }), hosAvailability: async () => ({ users: [] }), fleetRoster: async () => sandboxMotiveRoster(), iftaTrips: async () => sandboxMotiveIftaTrips(input) };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: MotiveClient, provider: string, input: In) {
  try {
    const [locations, hos] = await Promise.all([client.vehicleLocations(), client.hosAvailability()]);
    const out = normalizeMotive(input, locations, hos);
    return ok(input.discover ? { ...out, roster: normalizeRoster(await client.fleetRoster(), hos) } : out);
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "Motive did not answer.");
  }
}

/** The quarter's calendar days, first and last, as the company's report takes them. The exact bounds are applied by the normalizer. */
const quarterDays = (quarter: string): { start_date: string; end_date: string } => {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)!;
  const q = parseInt(m[2]!, 10);
  const last = ["03-31", "06-30", "09-30", "12-31"][q - 1]!;
  return { start_date: `${m[1]}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`, end_date: `${m[1]}-${last}` };
};

/** A quarter's miles: ask the company's IFTA report for the linked trucks over the quarter's days and normalize it. A call without the desk's clock or a quarter is refused before anything is asked. */
async function runIfta(client: MotiveClient, provider: string, input: EldIftaIn) {
  if (typeof input.asOf !== "number" || !Number.isFinite(input.asOf)) return err("bad_request", "The desk's clock (asOf) is required for a quarter's miles.");
  if (!/^\d{4}-Q[1-4]$/.test(input.quarter) || !Number.isFinite(new Date(input.from).getTime()) || !Number.isFinite(new Date(input.to).getTime())) return err("bad_request", "A quarter, like 2026-Q3, with its bounds.");
  try {
    // The trucks linked to the company by its id; none linked asks for the whole fleet, and the normalizer matches by name. The simulator answers from the trip hints whatever is asked.
    const ids = input.vehicles.flatMap((v) => (v.eldVehicleId != null && /^\d+$/.test(v.eldVehicleId) ? [parseInt(v.eldVehicleId, 10)] : []));
    const answer = await client.iftaTrips({ ...quarterDays(input.quarter), vehicle_ids: [...new Set(ids)] });
    return ok({ vehicles: [], iftaTrips: normalizeMotiveIfta(input, answer) });
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "Motive did not answer.");
  }
}

type AnyIn = AdapterShapes["eld"]["in"];

const live: Adapter<AnyIn, Out> = ({ provider, input }) => (input.op === "ifta_trips" ? runIfta(liveMotiveClient, provider, input) : run(liveMotiveClient, provider, input));
const sandbox: Adapter<AnyIn, Out> = ({ provider, input }) =>
  input.op === "ifta_trips" ? runIfta(sandboxMotiveIftaClient(input), provider, input) : run(sandboxMotiveClient(input, input.asOf != null ? new Date(input.asOf) : new Date()), provider, input);

export const motiveAdapter: ProviderAdapter<AnyIn, Out> = { live, sandbox };
