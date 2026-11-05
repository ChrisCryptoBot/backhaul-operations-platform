import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
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
      vehicle: { id: number; number: string };
      current_driver: { id: number; first_name: string; last_name: string } | null;
    };
  }>;
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
  }
};

const whole = (n: number) => n - (n % 1);
const minutesOf = (seconds: number) => whole(Math.max(0, seconds) / 60);
const hoursOf = (minutes: number) => new Prisma.Decimal(minutes).div(60).toDecimalPlaces(2).toNumber();
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
        location: { lat: place.lat, lng: place.lon, at: place.located_at }
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

/**
 * A simulated fleet, in the company's shapes: one vehicle per desk truck (the company's id is stable for a truck), placed at a hub that changes every six hours with a little drift each quarter
 * hour, and each driver's clocks consumed in proportion to the time of day. The same truck at the same quarter hour always answers the same, so a test can pin it.
 */
export function sandboxMotivePayloads(input: In, now: Date): { locations: MotiveLocations; hos: MotiveHos } {
  const driverOfTruck = new Map((input.drivers ?? []).filter((d) => d.vehicleId).map((d) => [d.vehicleId!, d]));
  const q = bucket(now);
  const sixHours = (now.getTime() - (now.getTime() % (6 * 3_600_000))) / (6 * 3_600_000);
  const users = new Map<number, MotiveHos["users"][number]>();

  const vehicle_locations = input.vehicles.map((truck) => {
    const seed = seedOf(truck.id);
    const vehicleId = truck.eldVehicleId && /^\d+$/.test(truck.eldVehicleId) ? parseInt(truck.eldVehicleId, 10) : 10_000 + (seed % 89_999);
    const hub = SANDBOX_HUBS[seedOf(`${truck.id}:${sixHours}`) % SANDBOX_HUBS.length]!;
    const lat = hub.lat + (unit(seed, q) - 0.5) * 0.3;
    const lng = hub.lng + (unit(seed, q + 1) - 0.5) * 0.3;
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
    const moving = unit(seed, q + 2) > 0.35;
    return {
      vehicle_location: {
        id: vehicleId * 1000 + (q % 1000),
        located_at: new Date(now.getTime() - (seedOf(`${truck.id}:${q}`) % 5) * 60_000).toISOString(),
        lat: new Prisma.Decimal(lat).toDecimalPlaces(6).toNumber(),
        lon: new Prisma.Decimal(lng).toDecimalPlaces(6).toNumber(),
        speed: moving ? 45 + (seedOf(`${truck.id}:s:${q}`) % 22) : 0,
        bearing: seedOf(`${truck.id}:b:${q}`) % 360,
        vehicle: { id: vehicleId, number: truck.name ?? `Truck ${vehicleId}` },
        current_driver
      }
    };
  });

  // A driver on no truck still has clocks (the company knows every driver it has an account for).
  for (const d of input.drivers ?? []) {
    const [first = "", ...rest] = d.name.trim().split(/\s+/);
    const userId = d.eldDriverId && /^\d+$/.test(d.eldDriverId) ? parseInt(d.eldDriverId, 10) : 50_000 + (seedOf(d.id) % 49_999);
    if (users.has(userId)) continue;
    users.set(userId, { user: { id: userId, first_name: first, last_name: rest.join(" ") }, hos_availability: { drive_remaining: 11 * 3600, shift_remaining: 14 * 3600, cycle_remaining: 60 * 3600, break_remaining: 8 * 3600 } });
  }
  return { locations: { vehicle_locations }, hos: { users: [...users.values()] } };
}

/** The simulator as a client: the company's calls, answered from `sandboxMotivePayloads`. */
export function sandboxMotiveClient(input: In, now: Date = new Date()): MotiveClient {
  const p = sandboxMotivePayloads(input, now);
  return { vehicleLocations: async () => p.locations, hosAvailability: async () => p.hos };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: MotiveClient, provider: string, input: In) {
  try {
    const [locations, hos] = await Promise.all([client.vehicleLocations(), client.hosAvailability()]);
    return ok(normalizeMotive(input, locations, hos));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "Motive did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveMotiveClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxMotiveClient(input), provider, input);

export const motiveAdapter: ProviderAdapter<In, Out> = { live, sandbox };
