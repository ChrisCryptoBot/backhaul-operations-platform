import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EldIftaIn, IftaTripHint } from "@/server/partners/call";
import { loadOfPiece, motiveAdapter, normalizeMotiveIfta, sandboxMotiveIftaTrips, type MotiveIftaTrips } from "@/server/partners/adapters/motive";
import { hintOf } from "@/server/partners/ifta-mileage";

/**
 * Wave 5 step 5a: a quarter's ELD miles by state, Motive-shaped. The simulator drives each truck from the desk's trip hints at the desk's clock only; the normalizer keeps a piece in the quarter
 * it starts in, ties it to the load it was driven on, keeps Canada out (counted), and never guesses.
 */
const Q3_FROM = "2026-07-01T05:00:00.000Z"; // America/Chicago
const Q3_TO = "2026-10-01T05:00:00.000Z";
const AS_OF = new Date("2026-11-13T15:00:00Z").getTime();
const at = (iso: string) => new Date(iso).getTime();

const hint = (loadId: string, origin: string, destination: string, pickup: string, delivered: string, loaded: string, dh = "0", ret = "0"): IftaTripHint => ({
  loadId,
  origin,
  destination,
  pickupAt: at(pickup),
  deliveredAt: at(delivered),
  loadedMiles: loaded,
  pickupDeadheadMiles: dh,
  returnDeadheadMiles: ret
});

const input = (over: Partial<EldIftaIn> = {}): EldIftaIn => ({
  op: "ifta_trips",
  quarter: "2026-Q3",
  from: Q3_FROM,
  to: Q3_TO,
  asOf: AS_OF,
  vehicles: [
    {
      id: "truck-a",
      name: "Unit 101",
      eldVehicleId: null,
      home: "Dallas, TX",
      trips: [
        hint("load-1", "Dallas, TX", "Atlanta, GA", "2026-07-10T14:00:00Z", "2026-07-11T22:00:00Z", "781.4567", "42.25", "0"),
        hint("load-2", "Atlanta, GA", "Charlotte, NC", "2026-07-13T12:00:00Z", "2026-07-13T19:00:00Z", "244", "0", "1010.5")
      ]
    },
    { id: "truck-b", name: "Unit 102", eldVehicleId: "4242", home: null, trips: [] }
  ],
  ...over
});

const sum = (xs: Array<{ distance: number } | { miles: string }>) => xs.reduce((s, x) => s.plus("distance" in x ? x.distance : x.miles), new Prisma.Decimal(0)).toFixed(1);

describe("the simulated IFTA trips report", () => {
  afterEach(() => vi.useRealTimers());

  test("drives the empty run, each load and the run home, split over the lane's states, the odometer running on piece to piece", () => {
    const trips = sandboxMotiveIftaTrips(input()).ifta_trips.map((t) => t.ifta_trip);
    // Dallas to Atlanta is the TX>GA corridor, Atlanta to Charlotte the GA>NC one; the empty run is inside Texas; the run home, Charlotte to Dallas, has no corridor (half each end).
    expect(trips.map((t) => [String(t.id).replace(/^sim-\d+-/, ""), t.jurisdiction])).toEqual([
      ["e-load-1-0", "TX"],
      ["l-load-1-0", "TX"],
      ["l-load-1-1", "LA"],
      ["l-load-1-2", "MS"],
      ["l-load-1-3", "AL"],
      ["l-load-1-4", "GA"],
      ["l-load-2-0", "GA"],
      ["l-load-2-1", "SC"],
      ["l-load-2-2", "NC"],
      ["r-load-2-0", "NC"],
      ["r-load-2-1", "TX"]
    ]);
    for (let i = 1; i < trips.length; i++) expect(trips[i]!.start_odometer).toBe(trips[i - 1]!.end_odometer);
    for (const t of trips) {
      expect(new Prisma.Decimal(t.end_odometer).minus(t.start_odometer).toFixed(1)).toBe(new Prisma.Decimal(t.distance).toFixed(1));
      expect(at(t.end_time)).toBeGreaterThan(at(t.start_time));
      expect(t.vehicle.number).toBe("Unit 101");
    }
    // A run's pieces add up to it exactly, to a tenth.
    expect(sum(trips.filter((t) => String(t.id).includes("-l-load-1-")))).toBe("781.5");
    expect(sum(trips.filter((t) => String(t.id).includes("-e-load-1-")))).toBe("42.3");
    expect(sum(trips.filter((t) => String(t.id).includes("-r-load-2-")))).toBe("1010.5");
    // The loaded run fills the pickup-to-delivery window; the empty run ends at the pickup.
    const loaded = trips.filter((t) => String(t.id).includes("-l-load-1-"));
    expect(loaded[0]!.start_time).toBe("2026-07-10T14:00:00.000Z");
    expect(loaded[loaded.length - 1]!.end_time).toBe("2026-07-11T22:00:00.000Z");
    expect(trips[0]!.end_time).toBe("2026-07-10T14:00:00.000Z");
    // A truck with no loads drove nothing the simulator knows of.
    expect(trips.every((t) => t.vehicle.number !== "Unit 102")).toBe(true);
  });

  test("the same input answers the same whatever the wall clock says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const a = sandboxMotiveIftaTrips(input());
    vi.setSystemTime(new Date("2019-05-05T00:00:00Z"));
    expect(sandboxMotiveIftaTrips(input())).toEqual(a);
  });

  test("nothing finished after the desk's clock is reported, and only pieces that touch the asked days", () => {
    const mid = at("2026-07-11T10:00:00Z");
    const early = sandboxMotiveIftaTrips(input({ asOf: mid })).ifta_trips.map((t) => t.ifta_trip);
    expect(early.length).toBeGreaterThan(0);
    expect(early.every((t) => at(t.end_time) <= mid)).toBe(true);
    expect(early.some((t) => String(t.id).includes("load-2"))).toBe(false);
    const later = sandboxMotiveIftaTrips(input({ from: "2026-07-12T00:00:00.000Z" })).ifta_trips.map((t) => t.ifta_trip);
    expect(later.every((t) => at(t.end_time) > at("2026-07-12T00:00:00Z"))).toBe(true);
  });

  test("a Canadian run is split onto its province", () => {
    const trips = sandboxMotiveIftaTrips(input({ vehicles: [{ id: "truck-c", name: "Unit 9", eldVehicleId: null, trips: [hint("load-ca", "Detroit, MI", "Toronto, ON", "2026-08-01T12:00:00Z", "2026-08-01T18:00:00Z", "230")] }] })).ifta_trips.map((t) => t.ifta_trip);
    expect(trips.map((t) => [t.jurisdiction, t.distance])).toEqual([
      ["MI", 115],
      ["ON", 115]
    ]);
  });
});

describe("the IFTA trips normalizer", () => {
  const piece = (id: string | number, jurisdiction: string, start: string, end: string, odo: [number, number], distance: number, vehicle = { id: 777, number: "Unit 101" }) => ({
    ifta_trip: { id, date: start.slice(0, 10), jurisdiction, vehicle, start_time: start, end_time: end, start_odometer: odo[0], end_odometer: odo[1], distance }
  });

  test("keeps US pieces tied to their load, counts Canada, leaves out what is outside the quarter, after the clock, unreadable or doubled", () => {
    const answer: MotiveIftaTrips = {
      ifta_trips: [
        piece(1, "TX", "2026-07-10T08:00:00Z", "2026-07-10T14:00:00Z", [1000, 1042.3], 42.25), // empty run before load-1
        piece(2, "Texas", "2026-07-10T14:00:00Z", "2026-07-11T00:00:00Z", [1042.3, 1308], 265.7), // loaded, a state written out
        piece(2, "TX", "2026-07-10T14:00:00Z", "2026-07-11T00:00:00Z", [1042.3, 1308], 265.7), // the same piece again
        piece(3, "ON", "2026-07-20T10:00:00Z", "2026-07-20T12:00:00Z", [2000, 2100], 100),
        piece(4, "TX", "2026-06-30T23:00:00Z", "2026-07-01T06:00:00Z", [900, 950], 50), // starts in Q2
        piece(5, "TX", "2026-09-30T23:00:00Z", "2026-10-01T09:00:00Z", [3000, 3100], 100), // starts in Q3 (Chicago), ends in Q4: kept whole
        piece(6, "XX", "2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z", [4000, 4010], 10),
        piece(7, "OK", "2026-08-02T10:00:00Z", "2026-08-02T11:00:00Z", [4010, 4000], 10), // odometer backwards
        piece(8, "OK", "2026-08-03T10:00:00Z", "not a time", [4010, 4020], 10)
      ]
    };
    const out = normalizeMotiveIfta(input({ asOf: at("2026-10-01T10:00:00Z") }), answer);
    expect(out.answered).toEqual(["truck-a"]);
    expect(out.canada).toEqual([{ vehicleId: "truck-a", jurisdiction: "ON", miles: "100.0" }]);
    expect(out.skipped).toEqual({ outsideQuarter: 1, afterAsOf: 0, unreadable: 3, duplicate: 1 });
    expect(out.pieces.map((p) => [p.externalId, p.jurisdiction, p.loaded, p.loadId, p.startOdometer, p.endOdometer, p.miles])).toEqual([
      ["1:TX", "TX", false, null, "1000.0", "1042.3", "42.3"],
      ["2:TX", "TX", true, "load-1", "1042.3", "1308.0", "265.7"],
      ["5:TX", "TX", false, null, "3000.0", "3100.0", "100.0"]
    ]);
    // The piece over the quarter's end is left out when the desk's clock is before its end.
    expect(normalizeMotiveIfta(input({ asOf: at("2026-10-01T08:00:00Z") }), answer).skipped.afterAsOf).toBe(1);
  });

  test("matches by the linked id first, else by name; one desk truck takes one company vehicle", () => {
    const answer: MotiveIftaTrips = {
      ifta_trips: [
        piece("a", "TX", "2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z", [1, 2], 1, { id: 4242, number: "Something else" }),
        piece("b", "TX", "2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z", [1, 2], 1, { id: 500, number: "unit 101 " }),
        piece("c", "TX", "2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z", [1, 2], 1, { id: 501, number: "Unit 101" }), // a second vehicle by the same name
        piece("d", "TX", "2026-08-01T10:00:00Z", "2026-08-01T11:00:00Z", [1, 2], 1, { id: 999, number: "Unit 102" }) // truck-b is linked to 4242, so not by name
      ]
    };
    const out = normalizeMotiveIfta(input(), answer);
    expect(out.pieces.map((p) => [p.externalId, p.vehicleId])).toEqual([
      ["b:TX", "truck-a"],
      ["a:TX", "truck-b"]
    ]);
    expect(out.answered).toEqual(["truck-a", "truck-b"]);
  });

  test("a piece is on the load whose window holds its middle", () => {
    const hints = input().vehicles[0]!.trips!;
    expect(loadOfPiece(hints, at("2026-07-10T13:00:00Z"), at("2026-07-10T14:00:00Z"))).toBeNull();
    expect(loadOfPiece(hints, at("2026-07-10T14:00:00Z"), at("2026-07-10T15:00:00Z"))).toBe("load-1");
    expect(loadOfPiece(hints, at("2026-07-13T17:00:00Z"), at("2026-07-13T20:00:00Z"))).toBe("load-2");
    expect(loadOfPiece(hints, at("2026-07-13T19:00:00Z"), at("2026-07-13T23:00:00Z"))).toBeNull();
  });
});

describe("the eld adapter's quarter-miles operation", () => {
  const call = (i: unknown, which: "live" | "sandbox" = "sandbox") => motiveAdapter[which]({ provider: "motive", input: i as EldIftaIn, secret: () => undefined });

  test("refuses without the desk's clock, never falling back to the wall clock", async () => {
    const { asOf: _drop, ...noClock } = input();
    expect(await call(noClock)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await call({ ...input(), asOf: Number.NaN })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await call({ ...input(), quarter: "2026Q3" })).toMatchObject({ ok: false, code: "bad_request" });
  });

  test("the simulator answers pieces and no positions; the live client is not implemented", async () => {
    const out = await call(input());
    if (!out.ok) throw new Error(out.message);
    expect(out.data.vehicles).toEqual([]);
    expect(out.data.iftaTrips?.answered).toEqual(["truck-a"]);
    expect(out.data.iftaTrips?.pieces.length).toBe(11);
    expect(sum(out.data.iftaTrips!.pieces)).toBe("2078.3");
    expect(out.data.iftaTrips!.pieces.filter((p) => p.loaded).map((p) => p.loadId)).toEqual(["load-1", "load-1", "load-1", "load-1", "load-1", "load-2", "load-2", "load-2"]);
    expect(await call(input(), "live")).toMatchObject({ ok: false, code: "not_implemented" });
  });
});

describe("a load as a trip hint", () => {
  const D = (n: number | string) => new Prisma.Decimal(n);
  const base = { id: "L", vehicleId: "T", status: "completed", originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", loadedMiles: D(781), pickupDeadheadMiles: D(10), returnDeadheadMiles: D(0) };
  test("picked up at the first stop's arrival (else window), delivered at completion", () => {
    const h = hintOf({ ...base, completedAt: new Date("2026-07-11T22:00:00Z"), stops: [{ addressString: "x", arrivedAt: new Date("2026-07-10T14:00:00Z"), timeWindowEarliest: null, timeWindowLatest: null }] });
    expect(h).toEqual({ loadId: "L", origin: "Dallas, TX", destination: "Atlanta, GA", pickupAt: at("2026-07-10T14:00:00Z"), deliveredAt: at("2026-07-11T22:00:00Z"), loadedMiles: "781.0000", pickupDeadheadMiles: "10.0000", returnDeadheadMiles: "0.0000" });
  });
  test("no pickup time: the loaded miles' drive time before delivery; no delivery time or no place: none", () => {
    const h = hintOf({ ...base, completedAt: new Date("2026-07-11T22:00:00Z"), stops: [] });
    expect(h!.deliveredAt - h!.pickupAt).toBe(56_232_000); // 781 mi at 50 mph
    expect(hintOf({ ...base, completedAt: null, stops: [] })).toBeNull();
    expect(hintOf({ ...base, originAddress: null, completedAt: new Date(), stops: [] })).toBeNull();
  });
});
