import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import { bearingDeg, interpolate } from "@/lib/geo-line";
import type { AdapterShapes, SimTrip } from "../call";
import { notImplemented } from "../not-implemented";
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

export interface MotiveClient {
  vehicleLocations(): Promise<MotiveLocations>;
  hosAvailability(): Promise<MotiveHos>;
  fleetRoster(): Promise<MotiveRoster>;
}

type In = AdapterShapes["eld"]["in"];
type Out = AdapterShapes["eld"]["out"];

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
const fleetOf = (truck: In["vehicles"][number]) => SANDBOX_FLEET.find((f) => (truck.eldVehicleId != null && String(f.id) === truck.eldVehicleId) || (truck.name != null && f.number.toLowerCase() === truck.name.trim().toLowerCase())) ?? null;

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
    const vehicleId = fleet ? fleet.id : truck.eldVehicleId && /^\d+$/.test(truck.eldVehicleId) ? parseInt(truck.eldVehicleId, 10) : 10_000 + (seed % 89_999);
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

/** The simulator as a client: the company's calls, answered from `sandboxMotivePayloads`. */
export function sandboxMotiveClient(input: In, now: Date = new Date()): MotiveClient {
  const p = sandboxMotivePayloads(input, now);
  return { vehicleLocations: async () => p.locations, hosAvailability: async () => p.hos, fleetRoster: async () => sandboxMotiveRoster() };
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

const live: Adapter<In, Out> = ({ provider, input }) => run(liveMotiveClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxMotiveClient(input, input.asOf != null ? new Date(input.asOf) : new Date()), provider, input);

export const motiveAdapter: ProviderAdapter<In, Out> = { live, sandbox };
