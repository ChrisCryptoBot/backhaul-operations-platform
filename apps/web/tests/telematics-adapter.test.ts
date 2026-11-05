import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { haversineMiles } from "@/lib/geo";
import { bearingDeg } from "@/lib/geo-line";
import { SANDBOX_FLEET, SANDBOX_HUBS, normalizeMotive, sandboxMotivePayloads, sandboxMotiveRoster } from "@/server/partners/adapters/motive";
import { ELD_RULES } from "./telematics-adapter.rules";

const H = 3_600_000;
const NOW = new Date("2026-11-05T17:00:00Z");
const DALLAS = { lat: 32.7767, lng: -96.797 };
const ATLANTA = { lat: 33.749, lng: -84.388 };

const truck = (over: Record<string, unknown> = {}) => ({ id: "tr-1", name: "Unit 9", eldVehicleId: null, ...over });
const place = (v: ReturnType<typeof truck>, now = NOW) => sandboxMotivePayloads({ vehicles: [v as never] }, now).locations.vehicle_locations[0]!.vehicle_location;

describe("the simulator puts a truck on its load's lane", () => {
  const trip = (startsAt: number, endsAt: number, inProgress: boolean) => ({ origin: DALLAS, destination: ATLANTA, startsAt, endsAt, inProgress });

  it("a load under way is somewhere along the lane, moving at a plausible speed on the lane's own heading", () => {
    const t = truck({ trip: trip(NOW.getTime() - 4 * H, NOW.getTime() + 8 * H, true) });
    const p = place(t);
    expect(p.engine_state).toBe("moving");
    expect(p.speed).toBeGreaterThanOrEqual(45);
    expect(p.speed).toBeLessThanOrEqual(66);
    expect(p.bearing).toBe(bearingDeg(DALLAS, ATLANTA));
    // On the line: the two legs add up to the whole (within a couple of miles of flat-earth slop).
    const legs = haversineMiles(DALLAS, { lat: p.lat, lng: p.lon }) + haversineMiles({ lat: p.lat, lng: p.lon }, ATLANTA);
    expect(legs - haversineMiles(DALLAS, ATLANTA)).toBeLessThan(3);
  });

  it("before the pickup it waits at the origin, after the delivery it sits at the destination, engine off or idling, speed 0", () => {
    const before = place(truck({ trip: trip(NOW.getTime() + 5 * H, NOW.getTime() + 20 * H, false) }));
    expect(haversineMiles(DALLAS, { lat: before.lat, lng: before.lon })).toBeLessThan(1);
    expect(before.speed).toBe(0);
    const after = place(truck({ trip: trip(NOW.getTime() - 30 * H, NOW.getTime() - 3 * H, false) }));
    expect(haversineMiles(ATLANTA, { lat: after.lat, lng: after.lon })).toBeLessThan(1);
    expect(["off", "idling"]).toContain(after.engine_state);
  });

  it("a load not yet under way moves along the lane by its own clock", () => {
    const start = NOW.getTime() - 4 * H;
    const half = place(truck({ trip: trip(start, start + 8 * H, false) })); // exactly halfway by the clock
    const d = haversineMiles(DALLAS, { lat: half.lat, lng: half.lon });
    expect(d / haversineMiles(DALLAS, ATLANTA)).toBeGreaterThan(0.4);
    expect(d / haversineMiles(DALLAS, ATLANTA)).toBeLessThan(0.6);
  });

  it("is stable inside a quarter hour and moves along after it", () => {
    const t = truck({ trip: trip(NOW.getTime() - 4 * H, NOW.getTime() + 8 * H, true) });
    const a = place(t);
    const same = place(t, new Date(NOW.getTime() + 60_000));
    expect([same.lat, same.lon, same.speed]).toEqual([a.lat, a.lon, a.speed]);
    const later = place(t, new Date(NOW.getTime() + 20 * 60_000));
    expect([later.lat, later.lon]).not.toEqual([a.lat, a.lon]);
  });
});

describe("a truck on no load is parked or idling, and idle time is reported", () => {
  it("parks at its home base, a few yards of drift at most, with the engine off or idling", () => {
    const home = { lat: 36.1627, lng: -86.7816 };
    const p = place(truck({ home }));
    expect(haversineMiles(home, { lat: p.lat, lng: p.lon })).toBeLessThan(0.2);
    expect(p.speed).toBe(0);
    expect(["off", "idling"]).toContain(p.engine_state);
    expect(p.idle_time_s).toBeGreaterThanOrEqual(0);
  });

  it("across a day of quarter hours some are idling, and an idling truck says how long it has stood", () => {
    // A dozen trucks over a day: idling is a stable third of six-hour blocks, so any one truck may not idle, but a fleet does.
    const states = Array.from({ length: 12 }, (_, k) => Array.from({ length: 96 }, (_, i) => place(truck({ id: `tr-idle-${k}` }), new Date(NOW.getTime() + i * 15 * 60_000)))).flat();
    const idling = states.filter((s) => s.engine_state === "idling");
    expect(idling.length).toBeGreaterThan(0);
    for (const s of idling) expect(s.stopped_for_s ?? 0).toBeGreaterThan(0);
    for (const s of states.filter((x) => x.engine_state === "off")) expect(s.stopped_for_s).toBeNull();
  });
});

describe("the company's own fleet, as a new account would list it", () => {
  it("lists eight trucks with 17-character VINs, make and model, and eight drivers with licences and their truck", () => {
    const r = sandboxMotiveRoster();
    expect(r.vehicles).toHaveLength(8);
    expect(r.users).toHaveLength(8);
    for (const v of r.vehicles) {
      expect(v.vin).toHaveLength(17);
      expect(v.make).toBeTruthy();
      expect(v.model).toBeTruthy();
    }
    for (const u of r.users) {
      expect(u.license_number).toMatch(/^[A-Z]{2}-/);
      expect(r.vehicles.some((v) => v.id === u.vehicle_id)).toBe(true);
    }
    expect(new Set(r.vehicles.map((v) => v.number)).size).toBe(8);
  });

  it("a desk truck named like one of them is placed on that truck's lane between two freight hubs, with its VIN", () => {
    const f = SANDBOX_FLEET[0]!;
    const p = place(truck({ name: f.number }));
    expect(p.vehicle.vin).toBe(f.vin);
    const a = SANDBOX_HUBS[f.lane[0]]!;
    const b = SANDBOX_HUBS[f.lane[1]]!;
    const legs = haversineMiles(a, { lat: p.lat, lng: p.lon }) + haversineMiles({ lat: p.lat, lng: p.lon }, b);
    expect(legs - haversineMiles(a, b)).toBeLessThan(3);
  });

  it("every fleet truck, at any hour of a day, is inside the continental US", () => {
    for (let i = 0; i < 24; i++) {
      const out = sandboxMotivePayloads({ vehicles: SANDBOX_FLEET.map((f) => truck({ id: `t-${f.id}`, name: f.number }) as never) }, new Date(NOW.getTime() + i * H));
      for (const { vehicle_location: l } of out.locations.vehicle_locations) {
        expect(l.lat).toBeGreaterThan(24);
        expect(l.lat).toBeLessThan(50);
        expect(l.lon).toBeGreaterThan(-125);
        expect(l.lon).toBeLessThan(-66);
      }
    }
  });
});

describe("the desk keeps what the ELD says, where it used to drop it", () => {
  it("speed, heading, engine, idle time and VIN survive the normalizer", () => {
    const input = { vehicles: [{ id: "d1", name: "Unit 101", eldVehicleId: null }] };
    const out = normalizeMotive(
      input,
      { vehicle_locations: [{ vehicle_location: { id: 1, located_at: "2026-11-05T16:58:00Z", lat: 32.7, lon: -96.8, speed: 64, bearing: 92, engine_state: "idling", idle_time_s: 3 * 3600 + 14 * 60, stopped_for_s: 3 * 3600 + 14 * 60, vehicle: { id: 901, number: "Unit 101", vin: "1FUJGHDV3NLAB3011" }, current_driver: null } }] },
      { users: [] }
    );
    expect(out.vehicles[0]).toMatchObject({ id: "d1", speedMph: 64, headingDeg: 92, engine: "idle", idleHoursToday: 3.23, idleMinutes: 194, vin: "1FUJGHDV3NLAB3011" });
  });

  it("a payload with none of the new fields still normalizes, with nulls", () => {
    const out = normalizeMotive({ vehicles: [{ id: "d1", name: "Unit 101", eldVehicleId: null }] }, { vehicle_locations: [{ vehicle_location: { id: 1, located_at: "2026-11-05T16:58:00Z", lat: 32.7, lon: -96.8, speed: null, bearing: null, vehicle: { id: 901, number: "Unit 101" }, current_driver: null } }] }, { users: [] });
    expect(out.vehicles[0]).toMatchObject({ speedMph: null, headingDeg: null, engine: null, idleHoursToday: null, idleMinutes: null, vin: null });
  });
});

describe("the simulator stays pure", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/server/partners/adapters/motive.ts"), "utf8");
  it("reads no clock and no randomness of its own (the same input and moment always answer the same), and opens no network", () => {
    const simulator = src.slice(src.indexOf("const HOUR"), src.indexOf("/** The simulated company's whole fleet and roster. */"));
    expect(simulator).not.toMatch(/Math\.random|Date\.now\(|new Date\(\)|fetch\(/);
    expect(ELD_RULES.keepsSpeedAndHeading(src)).toBe(true);
  });
});
