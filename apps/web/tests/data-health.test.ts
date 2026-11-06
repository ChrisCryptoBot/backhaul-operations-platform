import { describe, expect, test } from "vitest";
import { billedBase, buildDataHealth, completeness, fuelCheck, gradeOf, haversine, pingCheck, pingMiles, rateConCheck, type HealthLoad, type PingPoint } from "@/lib/data-health";

const load = (over: Partial<HealthLoad> = {}): HealthLoad => ({
  id: "l1",
  loadNumber: "L-1",
  status: "completed",
  completedAt: 1_000,
  broker: "Acme",
  origin: "Dallas, TX",
  destination: "Atlanta, GA",
  loadedMiles: 800,
  quotedRevenue: 2000,
  actualRevenue: 2000,
  vehicleId: "v1",
  truck: "T1",
  hasDriver: true,
  driverPay: true,
  marketBenchmark: 2.4,
  floor: 1.6,
  stops: 2,
  stopsWithArrival: 2,
  hasPod: true,
  podWaived: false,
  hasRateCon: true,
  expenseFuel: 400,
  cardFuel: null,
  cardGallons: null,
  paymentStatus: null,
  invoicedAmount: null,
  rateTotal: 2000,
  invoiceLines: null,
  ...over
});

describe("completeness", () => {
  test("a whole load scores 100% and names no gap", () => {
    const c = completeness({ loads: [load()], trucks: [], drivers: [], trailers: [] });
    expect(c.score).toBe(1);
    expect(c.checks.every((x) => x.gaps === 0)).toBe(true);
    expect(c.modules.find((m) => m.key === "loads")).toMatchObject({ passed: 13, checked: 13, score: 1 });
  });

  test("each gap is counted, with the load behind it", () => {
    const loads = [load({ id: "a", loadNumber: "A", marketBenchmark: null, floor: null }), load({ id: "b", loadNumber: "B", marketBenchmark: null }), load({ id: "c", loadNumber: "C" })];
    const c = completeness({ loads, trucks: [], drivers: [], trailers: [] });
    const market = c.checks.find((x) => x.key === "market")!;
    expect(market).toMatchObject({ checked: 3, passed: 1, gaps: 2 });
    expect(market.examples.map((e) => e.label)).toEqual(["A", "B"]);
    expect(c.checks.find((x) => x.key === "floor")).toMatchObject({ gaps: 1 });
  });

  test("a check counts only the items it applies to: a TONU needs no miles, a load with no driver needs no pay figure", () => {
    const loads = [load({ status: "tonu", loadedMiles: 0, hasDriver: false, driverPay: false })];
    const c = completeness({ loads, trucks: [], drivers: [], trailers: [] });
    expect(c.checks.find((x) => x.key === "miles")!.checked).toBe(0);
    expect(c.checks.find((x) => x.key === "pay")!.checked).toBe(0);
    expect(c.checks.find((x) => x.key === "revenue")!.checked).toBe(1);
  });

  test("a proof of delivery waived on purpose passes; a missing one does not", () => {
    const loads = [load({ id: "a", hasPod: false, podWaived: true }), load({ id: "b", hasPod: false })];
    expect(completeness({ loads, trucks: [], drivers: [], trailers: [] }).checks.find((x) => x.key === "pod")).toMatchObject({ checked: 2, passed: 1, gaps: 1 });
  });

  test("stops: arrival on every stop of a finished load", () => {
    const loads = [load({ id: "a", stops: 3, stopsWithArrival: 2 }), load({ id: "b" })];
    expect(completeness({ loads, trucks: [], drivers: [], trailers: [] }).checks.find((x) => x.key === "arrivals")).toMatchObject({ checked: 2, passed: 1, gaps: 1 });
  });

  test("units: trucks, drivers and trailers each have their own checks and score", () => {
    const c = completeness({
      loads: [],
      trucks: [{ id: "t1", name: "T1", hasProfile: true, hasBase: false, hasMpg: false }],
      drivers: [{ id: "d1", name: "Dee", hasCdlDate: true, hasMedicalDate: false, hasPhone: true }],
      trailers: [{ id: "r1", number: "R-1", hasRegistration: true, hasInspection: true }]
    });
    expect(c.modules.find((m) => m.key === "trucks")).toMatchObject({ checked: 3, passed: 1 });
    expect(c.modules.find((m) => m.key === "drivers")).toMatchObject({ checked: 3, passed: 2 });
    expect(c.modules.find((m) => m.key === "trailers")).toMatchObject({ score: 1 });
    expect(c.modules.find((m) => m.key === "loads")!.score).toBeNull(); // nothing to check is not 100%
  });

  test("the headline weights the modules that have something to check, and is null with nothing", () => {
    expect(completeness({ loads: [], trucks: [], drivers: [], trailers: [] }).score).toBeNull();
    const c = completeness({ loads: [], trucks: [{ id: "t", name: "T", hasProfile: true, hasBase: true, hasMpg: false }], drivers: [], trailers: [{ id: "r", number: "R", hasRegistration: false, hasInspection: false }] });
    // trucks 2/3 and trailers 0/2, equal weight: (0.6667 + 0) / 2
    expect(c.score).toBeCloseTo(1 / 3, 5);
  });

  test("the grade is a word for the score", () => {
    expect(gradeOf(null).tone).toBe("muted");
    expect(gradeOf(0.95).word).toBe("Ready for a read");
    expect(gradeOf(0.75).tone).toBe("warn");
    expect(gradeOf(0.4).tone).toBe("bad");
  });
});

describe("fuel card against the load's own fuel", () => {
  test("within the larger of $25 and a tenth is a match; beyond it is off; a card with nothing on the load is card-only", () => {
    const loads = [
      load({ id: "a", expenseFuel: 400, cardFuel: 430 }),
      load({ id: "b", expenseFuel: 400, cardFuel: 520 }),
      load({ id: "c", expenseFuel: 0, cardFuel: 300 }),
      load({ id: "d", expenseFuel: 100, cardFuel: 120 }),
      load({ id: "e", expenseFuel: 250, cardFuel: null })
    ];
    const f = fuelCheck(loads, true);
    expect(f).toMatchObject({ withCard: 4, matched: 2, off: 1, cardOnly: 1, cardOnlyDollars: 300, loadOnly: 1, offDollars: 120, hasCardData: true });
    expect(f.worst[0]).toMatchObject({ id: "b", diff: 120 });
  });

  test("with no card data at all, a load with fuel is not called load-only", () => {
    expect(fuelCheck([load({ expenseFuel: 250 })], false).loadOnly).toBe(0);
  });
});

describe("rate confirmation against the invoice", () => {
  test("the base is the line haul and surcharge lines; a detention or lumper line is an extra, not a difference", () => {
    expect(billedBase({ invoicedAmount: 2350, invoiceLines: [{ label: "Line haul", amount: 2000 }, { label: "Detention", amount: 250 }, { label: "Lumper", amount: 100 }] })).toBe(2000);
    expect(billedBase({ invoicedAmount: 2100, invoiceLines: [{ label: "Line haul", amount: 1900 }, { label: "Fuel surcharge", amount: 200 }] })).toBe(2100);
    expect(billedBase({ invoicedAmount: 1800, invoiceLines: null })).toBe(1800);
    expect(billedBase({ invoicedAmount: null, invoiceLines: null })).toBeNull();
  });

  test("matched to the dollar, billed under, billed over, and no rate confirmation to check against", () => {
    const loads = [
      load({ id: "a", paymentStatus: "invoiced", invoicedAmount: 2000 }),
      load({ id: "b", paymentStatus: "paid", invoicedAmount: 1850 }),
      load({ id: "c", paymentStatus: "invoiced", invoicedAmount: 2100 }),
      load({ id: "d", paymentStatus: "invoiced", invoicedAmount: 2000, hasRateCon: false }),
      load({ id: "e", paymentStatus: null }),
      load({ id: "f", paymentStatus: "invoiced", invoicedAmount: 2000.6 })
    ];
    const r = rateConCheck(loads);
    expect(r).toMatchObject({ invoiced: 5, checkable: 4, matched: 2, under: 1, underDollars: 150, over: 1, overDollars: 100, unchecked: 1 });
    expect(r.worst.map((w) => w.id)).toEqual(["b", "c"]);
  });

  test("an invoice with an extra line that the rate confirmation did not promise is not a short bill", () => {
    const l = load({ paymentStatus: "invoiced", invoicedAmount: 2250, invoiceLines: [{ label: "Line haul", amount: 2000 }, { label: "Detention", amount: 250 }] });
    expect(rateConCheck([l])).toMatchObject({ matched: 1, under: 0, over: 0 });
  });
});

describe("pings against billed miles", () => {
  // A straight run north along one meridian: 0.1 degree of latitude is about 6.9 miles.
  const run = (n: number, step = 0.1): PingPoint[] => Array.from({ length: n }, (_, i) => ({ lat: 30 + i * step, lng: -97, at: i * 600_000 }));

  test("straight-line miles along the pings, in time order", () => {
    expect(haversine({ lat: 30, lng: -97 }, { lat: 31, lng: -97 })).toBeCloseTo(69.09, 1);
    const shuffled = [...run(5)].reverse();
    expect(pingMiles(shuffled)).toBeCloseTo(pingMiles(run(5)), 6);
    expect(pingMiles(run(1))).toBe(0);
  });

  test("agreed inside the band, apart outside it, too few pings not said", () => {
    const miles = pingMiles(run(12, 0.5)); // about 380
    const trips = [
      { id: "a", label: "A", loadedMiles: miles * 1.1, points: run(12, 0.5) },
      { id: "b", label: "B", loadedMiles: miles * 2, points: run(12, 0.5) },
      { id: "c", label: "C", loadedMiles: miles * 0.5, points: run(12, 0.5) },
      { id: "d", label: "D", loadedMiles: 500, points: run(3) },
      { id: "e", label: "E", loadedMiles: 0, points: run(12) }
    ];
    const p = pingCheck(trips);
    expect(p).toMatchObject({ trips: 5, measured: 3, agreed: 1, apart: 2 });
    expect(p.worst.map((w) => w.id)).toEqual(["c", "b"]); // 2x pings and half the pings, the further from 1 first
  });
});

describe("the whole read", () => {
  test("counts what it read and runs every part", () => {
    const h = buildDataHealth({ loads: [load()], trucks: [], drivers: [], trailers: [], hasCardData: false, trips: [] });
    expect(h.counts).toEqual({ loads: 1, trucks: 0, drivers: 0, trailers: 0 });
    expect(h.completeness.score).toBe(1);
    expect(h.pings).toMatchObject({ trips: 0, measured: 0 });
  });
});
