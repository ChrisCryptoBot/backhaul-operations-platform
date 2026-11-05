import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routed, shippedProviders } from "@/server/partners/adapters";
import { normalizeMotive, sandboxMotivePayloads, type MotiveHos, type MotiveLocations } from "@/server/partners/adapters/motive";
import { keyMode, sandboxAllowed, seedOf } from "@/server/partners/adapters/sandbox";
import { sandboxFactoringEvent, triumphEventToNeutral } from "@/server/partners/adapters/triumphpay";
import { readEvent, verifySignature } from "@/server/partners/webhook-core";

const DEMO = {}; // sign-in off: the demo desk
const REAL = { DESK_AUTH: "on" };
const NOW = new Date("2026-12-02T15:00:00Z");

const input = {
  vehicles: [
    { id: "t1", name: "Unit 101", eldVehicleId: null },
    { id: "t2", name: "Unit 102", eldVehicleId: "777" },
    { id: "t3", name: "Unit 103", eldVehicleId: null }
  ],
  drivers: [
    { id: "d1", name: "Alex Rivera", eldDriverId: null, vehicleId: "t1" },
    { id: "d2", name: "Casey Brooks", eldDriverId: null, vehicleId: "t2" },
    { id: "d3", name: "Sam Okafor", eldDriverId: null, vehicleId: null }
  ]
};

describe("the sandbox switch", () => {
  const key = (v?: string) => (name: string) => (name === "MOTIVE_API_KEY" ? v : undefined);

  it("a real key, or none, is live", () => {
    expect(keyMode("motive", key("mk_live_abcdefgh"), DEMO)).toBe("live");
    expect(keyMode("motive", key(undefined), DEMO)).toBe("live");
    expect(keyMode("motive", key(""), DEMO)).toBe("live");
  });

  it("a sandbox_ key runs the simulator on the demo desk", () => {
    expect(keyMode("motive", key("sandbox_anything"), DEMO)).toBe("sandbox");
    expect(keyMode("motive", key("  sandbox_x"), DEMO)).toBe("sandbox");
  });

  it("on a real desk a sandbox_ key is refused, unless the operator switched the simulator on", () => {
    expect(sandboxAllowed(REAL)).toBe(false);
    expect(keyMode("motive", key("sandbox_anything"), REAL)).toBe("refused");
    expect(keyMode("motive", key("sandbox_anything"), { ...REAL, DESK_PARTNER_SANDBOX: "on" })).toBe("sandbox");
    expect(keyMode("motive", key("sandbox_anything"), { ...REAL, DESK_PARTNER_SANDBOX: "yes" })).toBe("refused");
  });

  it("only the company's primary key decides: a sandbox_ webhook secret alone does not", () => {
    expect(keyMode("motive", (n) => (n === "MOTIVE_WEBHOOK_SECRET" ? "sandbox_x" : undefined), DEMO)).toBe("live");
  });
});

describe("the simulator answers realistic ELD payloads, the same way for the same quarter hour", () => {
  it("is stable for a truck and a quarter hour (a fix is stamped just before now), and moves on the next", () => {
    const place = (p: ReturnType<typeof sandboxMotivePayloads>) => p.locations.vehicle_locations.map(({ vehicle_location: l }) => [l.vehicle.id, l.lat, l.lon, l.speed]);
    const a = sandboxMotivePayloads(input, NOW);
    expect(sandboxMotivePayloads(input, NOW)).toEqual(a);
    expect(place(sandboxMotivePayloads(input, new Date(NOW.getTime() + 60_000)))).toEqual(place(a));
    expect(sandboxMotivePayloads(input, new Date(NOW.getTime() + 16 * 60_000)).hos).not.toEqual(a.hos);
    expect(place(sandboxMotivePayloads(input, new Date(NOW.getTime() + 16 * 60_000)))).not.toEqual(place(a));
    expect(seedOf("t1")).toBe(seedOf("t1"));
  });

  it("puts every tractor in the continental US with a plausible speed and a recent fix", () => {
    for (const { vehicle_location: l } of sandboxMotivePayloads(input, NOW).locations.vehicle_locations) {
      expect(l.lat).toBeGreaterThan(24);
      expect(l.lat).toBeLessThan(50);
      expect(l.lon).toBeGreaterThan(-125);
      expect(l.lon).toBeLessThan(-66);
      expect(l.speed === 0 || (l.speed! >= 45 && l.speed! <= 66)).toBe(true);
      expect(NOW.getTime() - Date.parse(l.located_at)).toBeLessThan(6 * 60_000);
      expect(Date.parse(l.located_at)).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("keeps each driver's clocks inside the rules: 11 hours to drive, 14 on duty, 70 in the cycle, in whole minutes", () => {
    for (const { hos_availability: h } of sandboxMotivePayloads(input, NOW).hos.users) {
      expect(h.drive_remaining).toBeLessThanOrEqual(11 * 3600);
      expect(h.shift_remaining).toBeLessThanOrEqual(14 * 3600);
      expect(h.cycle_remaining).toBeLessThanOrEqual(70 * 3600);
      for (const v of [h.drive_remaining, h.shift_remaining, h.cycle_remaining]) {
        expect(v).toBeGreaterThan(0);
        expect(v % 60).toBe(0);
      }
    }
  });

  it("gives the tractor's own driver on the truck and every driver a set of clocks", () => {
    const p = sandboxMotivePayloads(input, NOW);
    const names = p.locations.vehicle_locations.map((l) => l.vehicle_location.current_driver && `${l.vehicle_location.current_driver.first_name} ${l.vehicle_location.current_driver.last_name}`);
    expect(names).toEqual(["Alex Rivera", "Casey Brooks", null]);
    expect(p.hos.users.map((u) => `${u.user.first_name} ${u.user.last_name}`).sort()).toEqual(["Alex Rivera", "Casey Brooks", "Sam Okafor"]);
  });
});

describe("the normalizer turns the company's shapes into the desk's", () => {
  const locations: MotiveLocations = {
    vehicle_locations: [
      { vehicle_location: { id: 1, located_at: "2026-12-02T14:58:00Z", lat: 32.78, lon: -96.8, speed: 55, bearing: 90, vehicle: { id: 901, number: "unit 101" }, current_driver: { id: 5001, first_name: "Alex", last_name: "Rivera" } } },
      { vehicle_location: { id: 2, located_at: "2026-12-02T14:50:00Z", lat: 33.75, lon: -84.39, speed: 0, bearing: null, vehicle: { id: 777, number: "Unit 102 (renamed)" }, current_driver: null } },
      { vehicle_location: { id: 3, located_at: "2026-12-02T14:59:00Z", lat: 40, lon: -90, speed: 10, bearing: 0, vehicle: { id: 555, number: "Someone else's truck" }, current_driver: null } }
    ]
  };
  const hos: MotiveHos = {
    users: [
      { user: { id: 5001, first_name: "Alex", last_name: "Rivera" }, hos_availability: { drive_remaining: 7 * 3600 + 30 * 60, shift_remaining: 6 * 3600, cycle_remaining: 41 * 3600, break_remaining: 3600 } },
      { user: { id: 5002, first_name: "Sam", last_name: "Okafor" }, hos_availability: { drive_remaining: 11 * 3600, shift_remaining: 14 * 3600, cycle_remaining: 60 * 3600, break_remaining: 3600 } }
    ]
  };

  it("matches a truck by its linked id, else by name, and leaves out what it cannot match", () => {
    const out = normalizeMotive(input, locations, hos);
    expect(out.vehicles.map((v) => [v.id, v.eldVehicleId])).toEqual([["t1", "901"], ["t2", "777"]]); // t3 has no match
    expect(out.vehicles[0]!.location).toEqual({ lat: 32.78, lng: -96.8, at: "2026-12-02T14:58:00Z" });
  });

  it("a tractor's hours available are the driver's drive or shift clock, whichever is less", () => {
    const out = normalizeMotive(input, locations, hos);
    expect(out.vehicles[0]!.hosAvailableHours).toBe(6); // 7.5 h to drive, 6 h on duty
    expect(out.vehicles[1]!.hosAvailableHours).toBeNull(); // no driver on it
  });

  it("a driver is matched by id, else by full name, and the clocks are whole minutes", () => {
    const out = normalizeMotive(input, locations, hos);
    expect(out.drivers).toEqual([
      { id: "d1", eldDriverId: "5001", driveMinutes: 450, shiftMinutes: 360, cycleMinutes: 2460 },
      { id: "d3", eldDriverId: "5002", driveMinutes: 660, shiftMinutes: 840, cycleMinutes: 3600 }
    ]);
  });
});

describe("the factor's confirmations", () => {
  const SECRET = "sandbox_whsec_test_value";
  const ev = (kind: Parameters<typeof sandboxFactoringEvent>[0]["kind"]) => sandboxFactoringEvent({ kind, invoiceNumber: "INV-9", referenceId: "TP-SBX-INV-9", id: `evt_${kind}`, secret: SECRET, now: NOW });

  it("is signed the way the receiver checks, and a changed byte fails", () => {
    const e = ev("factoring.funded");
    expect(verifySignature(e.raw, e.signature, SECRET)).toBe(true);
    expect(verifySignature(e.raw + " ", e.signature, SECRET)).toBe(false);
    expect(verifySignature(e.raw, e.signature, "other-secret-value")).toBe(false);
  });

  it("reads back, in the factor's own shape, as the neutral event the desk acts on", () => {
    for (const kind of ["factoring.submitted", "factoring.funded", "factoring.paid", "factoring.rejected", "ping"] as const) {
      const e = ev(kind);
      expect(triumphEventToNeutral(JSON.parse(e.raw)), kind).toMatchObject({ id: `evt_${kind}`, kind });
    }
    expect(readEvent("triumphpay", JSON.parse(ev("factoring.funded").raw), ev("factoring.funded").raw)).toEqual({ id: "evt_factoring.funded", kind: "factoring.funded", reference: "INV-9", referenceId: "TP-SBX-INV-9" });
  });

  it("a company with no shape of its own is read as the neutral envelope, and nonsense is nothing", () => {
    const neutral = JSON.stringify({ id: "x1", type: "factoring.funded", reference: "INV-1" });
    expect(readEvent("someone", JSON.parse(neutral), neutral)).toMatchObject({ kind: "factoring.funded", reference: "INV-1" });
    expect(readEvent("triumphpay", { hello: "world" }, "{}")).toBeNull();
    expect(triumphEventToNeutral({ event_id: "a", event_type: "something.else", data: {} })).toBeNull();
  });
});

describe("the router", () => {
  const eld = routed("eld");
  const key = (value: string, name = "MOTIVE_API_KEY") => (n: string) => (n === name ? value : undefined);

  it("ships ELD for Motive and factoring for TriumphPay, and nothing else yet", () => {
    expect(shippedProviders("eld")).toEqual(["motive"]);
    expect(shippedProviders("factoring")).toEqual(["triumphpay"]);
    expect(shippedProviders("fuel_card")).toEqual([]);
  });

  it("a sandbox key on the demo desk answers from the simulator; a real key answers 'not implemented' until the company is wired", async () => {
    const sim = await eld({ provider: "motive", input, secret: key("sandbox_k") });
    expect(sim.ok).toBe(true);
    const live = await eld({ provider: "motive", input, secret: key("mk_live_abcdef") });
    expect(live).toMatchObject({ ok: false, code: "not_implemented" });
  });

  it("a company with no adapter is 'not implemented' even with a sandbox key", async () => {
    expect(await eld({ provider: "samsara", input, secret: key("sandbox_k", "SAMSARA_API_KEY") })).toMatchObject({ ok: false, code: "not_implemented" });
  });
});

describe("nothing an adapter does leaves the desk", () => {
  const dir = path.join(__dirname, "..", "src", "server", "partners", "adapters");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const code = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no adapter file calls fetch, opens a socket or imports an HTTP client", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const text = code(f);
      expect(text, f).not.toMatch(/\bfetch\s*\(/);
      expect(text, f).not.toMatch(/node:(http|https|net|tls|dgram|dns)/);
      expect(text, f).not.toMatch(/\b(axios|undici|got|node-fetch|XMLHttpRequest|WebSocket)\b/);
      expect(text, f).not.toMatch(/https?:\/\//);
    }
  });
});
