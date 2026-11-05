import { describe, expect, it } from "vitest";
import { shippedProviders, routed } from "@/server/partners/adapters";
import { normalizeHighway, sandboxHighwayCarrier, MIN_SAFETY_SCORE } from "@/server/partners/adapters/highway";
import { gustoEventToNeutral, normalizeGusto, sandboxGustoClient, sandboxPayrollEvent, toGustoPayments } from "@/server/partners/adapters/gusto";
import { normalizeP44, p44EventToNeutral, sandboxP44Client, sandboxTrackingEvent } from "@/server/partners/adapters/project44";
import { CORRIDORS, normalizeProMiles, sandboxProMilesClient, sandboxSplit } from "@/server/partners/adapters/promiles";
import { normalizeWex, sandboxWexTransactions, type WexTransactions } from "@/server/partners/adapters/wex";
import { readEvent, verifySignature } from "@/server/partners/webhook-core";

const NOW = new Date("2026-12-02T15:00:00Z");

describe("fuel cards, modeled after WEX", () => {
  const input = { vehicleName: "Unit 101", accountId: "WEX-9", since: "2026-11-25", until: "2026-12-02" };

  it("the simulator is stable for a unit and a day, covers the window, and charges the discounted price", () => {
    const a = sandboxWexTransactions(input, NOW);
    expect(sandboxWexTransactions(input, NOW)).toEqual(a);
    expect(a.transactions.length).toBeGreaterThan(2);
    for (const t of a.transactions) {
      expect(t.account).toBe("WEX-9");
      expect(t.unit).toBe("Unit 101");
      expect(t.posted_at.slice(0, 10) >= "2026-11-25" && t.posted_at.slice(0, 10) <= "2026-12-02").toBe(true);
      if (t.product === "DIESEL") {
        expect(t.gallons).toBeGreaterThanOrEqual(70);
        expect(t.gallons).toBeLessThanOrEqual(140);
        expect(t.price_per_gallon).toBeGreaterThan(3.5);
        expect(t.discount_per_gallon).toBeGreaterThanOrEqual(0.1);
        expect(t.discount_per_gallon).toBeLessThanOrEqual(0.45);
        expect(t.total).toBeCloseTo((t.price_per_gallon - t.discount_per_gallon) * t.gallons, 1);
      }
    }
    // Another unit on the same account has its own purchases.
    expect(sandboxWexTransactions({ ...input, vehicleName: "Unit 102" }, NOW)).not.toEqual(a);
  });

  const tx: WexTransactions = {
    transactions: [
      { transaction_id: "a", posted_at: "2026-12-01T10:00:00Z", account: "WEX-9", unit: "unit 101", merchant: { name: "Pilot", city: "Dallas", state: "TX" }, product: "DIESEL", gallons: 100, price_per_gallon: 4, discount_per_gallon: 0.25, total: 375 },
      { transaction_id: "b", posted_at: "2026-12-01T10:05:00Z", account: "WEX-9", unit: "Unit 101", merchant: { name: "Pilot", city: "Dallas", state: "TX" }, product: "DEF", gallons: 4, price_per_gallon: 4.2, discount_per_gallon: 0, total: 16.8 },
      { transaction_id: "c", posted_at: "2026-12-01T10:00:00Z", account: "WEX-9", unit: "Unit 102", merchant: { name: "Love's", city: "Waco", state: "TX" }, product: "DIESEL", gallons: 80, price_per_gallon: 4, discount_per_gallon: 0.1, total: 312 },
      { transaction_id: "d", posted_at: "2026-10-01T10:00:00Z", account: "WEX-9", unit: "Unit 101", merchant: { name: "Old", city: "X", state: "TX" }, product: "DIESEL", gallons: 50, price_per_gallon: 4, discount_per_gallon: 0, total: 200 },
      { transaction_id: "e", posted_at: "2026-12-01T10:00:00Z", account: "OTHER", unit: "Unit 101", merchant: { name: "Else", city: "X", state: "TX" }, product: "DIESEL", gallons: 60, price_per_gallon: 4, discount_per_gallon: 0, total: 240 }
    ]
  };

  it("keeps this unit's, this account's, these days' purchases; the amount is what the card was charged; DEF has no gallons", () => {
    const out = normalizeWex(input, tx);
    expect(out.purchases.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out.purchases[0]).toMatchObject({ on: "2026-12-01", gallons: 100, amount: 375, location: "Pilot, Dallas, TX", pricePerGallon: 4, discountPerGallon: 0.25, discount: 25 });
    expect(out.purchases[1]).toMatchObject({ gallons: null, amount: 16.8 });
  });
});

describe("load tracking, modeled after project44", () => {
  const stops = [
    { sequence: 1, role: "pickup", city: "Dallas", opensAt: "2026-12-02T08:00:00Z" },
    { sequence: 2, role: "delivery", city: "Atlanta", opensAt: "2026-12-04T08:00:00Z" }
  ];

  it("the simulator opens a shipment with a link on a name that never resolves, and stops it", async () => {
    const c = sandboxP44Client({ loadId: "L1", share: true, stops }, NOW);
    const s = await c.openShipment({ reference: "DM-1", stops: [] });
    expect(s).toMatchObject({ status: "active" });
    expect(s.tracking_url).toMatch(/^https:\/\/track\.sandbox\.invalid\/s\/p44-[0-9a-f]+$/);
    expect(await c.openShipment({ reference: "DM-1", stops: [] })).toEqual(s); // the same load is the same shipment
    expect(normalizeP44(s, null)).toEqual({ sharing: true, shareUrl: s.tracking_url, milestones: [] });
    expect(normalizeP44(await c.stopShipment(s.shipment_id), null)).toMatchObject({ sharing: false, shareUrl: null });
  });

  it("geofence events follow the load's own windows: a stop whose window has opened is entered, then left, and a later one is not", async () => {
    const c = sandboxP44Client({ loadId: "L1", share: true, stops }, new Date("2026-12-02T12:00:00Z"));
    const events = (await c.events("p44-x")).events;
    expect(events.map((e) => [e.stop_sequence, e.type])).toEqual([[1, "geofence.entered"], [1, "geofence.exited"]]);
    const none = (await sandboxP44Client({ loadId: "L1", share: true, stops }, new Date("2026-12-02T07:00:00Z")).events("p44-x")).events;
    expect(none).toEqual([]);
    expect(normalizeP44({ shipment_id: "x", tracking_url: "u", status: "active" }, { events }).milestones).toEqual(events.map((e) => ({ stop: e.stop_sequence, kind: e.type === "geofence.entered" ? "arrived" : "departed", at: e.occurred_at })));
  });

  it("a signed geofence event reads back as the neutral one, with its stop", () => {
    const e = sandboxTrackingEvent({ kind: "tracking.arrived", loadNumber: "DM-1", stop: 2, id: "evt_t1", secret: "sandbox_whsec_t", now: NOW });
    expect(verifySignature(e.raw, e.signature, "sandbox_whsec_t")).toBe(true);
    expect(p44EventToNeutral(JSON.parse(e.raw))).toEqual({ id: "evt_t1", kind: "tracking.arrived", reference: "DM-1", referenceId: null, stop: 2 });
    expect(readEvent("project44", JSON.parse(e.raw), e.raw)).toMatchObject({ kind: "tracking.arrived", stop: 2 });
    expect(p44EventToNeutral({ event_id: "x", event_type: "something.else" })).toBeNull();
  });
});

describe("carrier vetting, modeled after Highway", () => {
  const read = (mc: string) => normalizeHighway(sandboxHighwayCarrier({ mc, dot: null }, NOW), NOW);

  it("the simulator shows every outcome on purpose, chosen by the MC's last digit", () => {
    expect(read("1234560")).toMatchObject({ status: "failed", authorityActive: false });
    expect(read("1234561")).toMatchObject({ status: "review", flags: expect.arrayContaining([expect.stringContaining("lapses within 30 days")]) });
    expect(read("1234562")).toMatchObject({ status: "review", safetyScore: 48 });
    expect(read("1234563")).toMatchObject({ status: "review", cargoCoverage: 50_000 });
    expect(read("1234564")).toMatchObject({ status: "failed", flags: expect.arrayContaining(["The liability certificate has lapsed."]) });
    expect(read("1234565")).toMatchObject({ status: "clear", authorityActive: true, flags: [] });
    expect(read("1234565").safetyScore!).toBeGreaterThanOrEqual(MIN_SAFETY_SCORE);
  });

  it("keeps the earliest certificate date, which is the one that matters", () => {
    expect(read("1234561").coiExpiresAt).toBe("2026-12-14"); // 12 days out
    expect(read("1234565")!.coiExpiresAt! > "2027-05-01").toBe(true);
  });

  it("no liability certificate at all is a failure; a lapsed cargo certificate alone is a review", () => {
    const base = sandboxHighwayCarrier({ mc: "1234565", dot: null }, NOW);
    expect(normalizeHighway({ carrier: { ...base.carrier, insurance: base.carrier.insurance.filter((i) => i.kind === "CARGO") } }, NOW).status).toBe("failed");
    expect(normalizeHighway({ carrier: { ...base.carrier, insurance: base.carrier.insurance.map((i) => (i.kind === "CARGO" ? { ...i, expires_on: "2026-01-01" } : i)) } }, NOW).status).toBe("review");
  });

  it("falls back to the DOT number and treats none as the first outcome", () => {
    expect(normalizeHighway(sandboxHighwayCarrier({ mc: null, dot: "7654325" }, NOW), NOW).status).toBe("clear");
  });
});

describe("payroll, modeled after Gusto", () => {
  const statements = [
    { id: "s1", number: "ST-1", employeeId: "w-1", workerType: "contractor", total: 1234.5, periodStart: "2026-11-02", periodEnd: "2026-11-08" },
    { id: "s2", number: "ST-2", employeeId: "w-2", workerType: "employee", total: 800, periodStart: "2026-11-02", periodEnd: "2026-11-08", idempotencyKey: "statement:s2" }
  ];

  it("turns a statement into one payment, a contractor as a contractor and an employee as wages, keyed so it is paid once", () => {
    const { payments, unknown } = toGustoPayments({ statements });
    expect(unknown).toEqual([]);
    expect(payments).toEqual([
      { idempotency_key: "statement:s1", worker_id: "w-1", worker_kind: "contractor", amount: "1234.50", period_start: "2026-11-02", period_end: "2026-11-08", memo: "Driver statement ST-1" },
      expect.objectContaining({ idempotency_key: "statement:s2", worker_kind: "employee", amount: "800.00" })
    ]);
  });

  it("a statement for a worker the company does not know is named and nothing is sent", async () => {
    const r = routed("payroll");
    const out = await r({ provider: "gusto", input: { statements: [...statements, { id: "s3", number: "ST-3", employeeId: null, workerType: null, total: 10, periodStart: "2026-11-02", periodEnd: "2026-11-08" }] }, secret: (n) => (n === "GUSTO_CLIENT_ID" ? "sandbox_gusto" : "x") });
    expect(out).toMatchObject({ ok: false, code: "bad_request", message: expect.stringContaining("ST-3") });
  });

  it("the simulator answers the same run for the same batch (never a second run) and rejects a payment of nothing", async () => {
    const a = await sandboxGustoClient.submitPayments({ payments: toGustoPayments({ statements }).payments });
    const b = await sandboxGustoClient.submitPayments({ payments: [...toGustoPayments({ statements }).payments].reverse() });
    expect(a.run_id).toMatch(/^GUS-SBX-[0-9A-F]{10}$/);
    expect(b.run_id).toBe(a.run_id);
    const zero = await sandboxGustoClient.submitPayments({ payments: toGustoPayments({ statements: [{ ...statements[0]!, total: 0 }] }).payments });
    expect(normalizeGusto(zero, [])).toMatchObject({ ok: false, code: "bad_request" });
    expect(normalizeGusto(a, [])).toMatchObject({ ok: true, data: { reference: a.run_id } });
  });

  it("a cleared pay run is a signed event in the company's shape that reads back as the neutral one", () => {
    const e = sandboxPayrollEvent({ kind: "payroll.paid", runId: "GUS-SBX-ABC", id: "evt_p1", secret: "sandbox_whsec_g", now: NOW });
    expect(verifySignature(e.raw, e.signature, "sandbox_whsec_g")).toBe(true);
    expect(gustoEventToNeutral(JSON.parse(e.raw))).toEqual({ id: "evt_p1", kind: "payroll.paid", reference: "GUS-SBX-ABC", referenceId: null, stop: null });
    expect(readEvent("gusto", JSON.parse(e.raw), e.raw)).toMatchObject({ kind: "payroll.paid" });
  });
});

describe("fuel tax (IFTA), modeled after ProMiles", () => {
  const sum = (rows: Array<{ miles: number }>) => rows.reduce((s, r) => s + r.miles, 0);

  it("splits a trip's miles across the states it passes through, in either direction, adding up to the trip", () => {
    const fwd = sandboxSplit("Dallas, TX", "Atlanta, GA", 800);
    expect(fwd.map((r) => r.state)).toEqual(["TX", "LA", "MS", "AL", "GA"]);
    expect(sum(fwd)).toBeCloseTo(800, 0);
    const back = sandboxSplit("Atlanta, GA", "Dallas, TX", 800);
    expect([...back.map((r) => r.state)].sort()).toEqual([...fwd.map((r) => r.state)].sort());
    expect(sum(back)).toBeCloseTo(800, 0);
    for (const [k, path] of Object.entries(CORRIDORS)) expect(path.reduce((s, [, f]) => s + f, 0), k).toBeCloseTo(1, 5);
  });

  it("a trip inside one state is all that state's; two states with no corridor split between the ends; a place with no state is left out", () => {
    expect(sandboxSplit("Kansas City, MO", "St. Louis, MO", 250)).toEqual([{ state: "MO", miles: 250 }]);
    expect(sandboxSplit("Boise, ID", "Billings, MT", 600)).toEqual([{ state: "ID", miles: 300 }, { state: "MT", miles: 300 }]);
    expect(sandboxSplit("Somewhere", "Atlanta, GA", 100)).toEqual([]);
    expect(sandboxSplit("Dallas, TX 75201", "Atlanta, GA 30301", 100).length).toBe(5);
  });

  it("adds the quarter up by state and works out the fuel those miles burned at each truck's miles to the gallon", async () => {
    const trips = [
      { id: "l1", vehicleId: "t1", origin: "Dallas, TX", destination: "Atlanta, GA", miles: 800, mpg: 8 },
      { id: "l2", vehicleId: "t2", origin: "Dallas, TX", destination: "Dallas, TX", miles: 100, mpg: null }
    ];
    const answer = await sandboxProMilesClient.mileage({ trips });
    const out = normalizeProMiles({ quarter: "2026-Q4", vehicles: [], trips }, answer);
    const tx = out.jurisdictions.find((j) => j.state === "TX")!;
    expect(tx.miles).toBeCloseTo(0.34 * 800 + 100, 1);
    expect(tx.gallons).toBeCloseTo((0.34 * 800) / 8 + 100 / 6.5, 1);
    expect(out.jurisdictions.map((j) => j.state)).toEqual(["AL", "GA", "LA", "MS", "TX"]);
  });
});

describe("the shelf", () => {
  it("ships an adapter for every shelf the plan names, each company in its own file", () => {
    expect(shippedProviders("fuel_card")).toEqual(["wex"]);
    expect(shippedProviders("tracking")).toEqual(["project44"]);
    expect(shippedProviders("vetting")).toEqual(["highway"]);
    expect(shippedProviders("payroll")).toEqual(["gusto"]);
    expect(shippedProviders("ifta")).toEqual(["promiles"]);
  });
});
