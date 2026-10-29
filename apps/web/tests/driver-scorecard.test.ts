import { describe, expect, it } from "vitest";
import { driverScorecard, scoreLoad, type ScoreLoad } from "../src/lib/driver-scorecard";

const T0 = Date.parse("2026-10-20T14:00:00Z");
const M = 60_000;
const at = (min: number) => new Date(T0 + min * M);

/** A pickup window of an hour at T0 and a delivery window of two hours six hours later. */
function load(over: Partial<ScoreLoad> = {}): ScoreLoad {
  return {
    id: "l1",
    loadNumber: "DM-1",
    lane: "Dallas, TX → Tulsa, OK",
    completedAt: at(7 * 60),
    stops: [
      { earliest: at(0), latest: at(60), arrivedAt: at(30) },
      { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }
    ],
    loadedMiles: 260,
    pickupDeadheadMiles: 20,
    returnDeadheadMiles: 20,
    isBackhaul: false,
    payEstimate: 130,
    invoicedAmount: 1000,
    paidAmount: 1000,
    paymentStatus: "paid",
    ...over
  };
}

describe("on time, by the phone's rule (an hour early and half an hour late are fine)", () => {
  it("scores a stop that arrived inside its window", () => {
    expect(scoreLoad(load())).toMatchObject({ stopsScored: 2, stopsOnTime: 2, worstLateMinutes: null });
  });

  it("allows half an hour after the window closes, and no more", () => {
    const within = scoreLoad(load({ stops: [{ earliest: at(0), latest: at(60), arrivedAt: at(60 + 29) }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }] }));
    expect(within.stopsOnTime).toBe(2);
    const late = scoreLoad(load({ stops: [{ earliest: at(0), latest: at(60), arrivedAt: at(60 + 45) }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }] }));
    expect(late).toMatchObject({ stopsScored: 2, stopsOnTime: 1, worstLateMinutes: 45 });
  });

  it("allows an hour early, and calls earlier than that off schedule too", () => {
    const early = scoreLoad(load({ stops: [{ earliest: at(0), latest: at(60), arrivedAt: at(-50) }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }] }));
    expect(early.stopsOnTime).toBe(2);
    const tooEarly = scoreLoad(load({ stops: [{ earliest: at(0), latest: at(60), arrivedAt: at(-90) }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }] }));
    expect(tooEarly).toMatchObject({ stopsOnTime: 1, worstLateMinutes: null }); // early is not late
  });

  it("takes the delivery's arrival from the time it was delivered when no arrival was entered, and leaves out what cannot be scored", () => {
    const noArrival = scoreLoad(load({ stops: [{ earliest: at(0), latest: at(60), arrivedAt: null }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: null }], completedAt: at(9 * 60) }));
    expect(noArrival).toMatchObject({ stopsScored: 1, stopsOnTime: 0, worstLateMinutes: 60 }); // delivered an hour after the window closed; the pickup has no arrival
    const noWindows = scoreLoad(load({ stops: [{ earliest: null, latest: null, arrivedAt: at(5) }, { earliest: null, latest: null, arrivedAt: at(500) }] }));
    expect(noWindows.stopsScored).toBe(0);
  });
});

describe("a driver's scorecard", () => {
  it("is empty with no loads: no rates, nothing owed", () => {
    expect(driverScorecard([])).toMatchObject({ loads: 0, onTime: { scored: 0, onTime: 0, rate: null }, empty: { share: null }, pay: 0, shortPaid: { loads: 0, dollars: 0 }, worstLateMinutes: null });
  });

  it("gives the on-time rate over every stop scored, and the worst lateness", () => {
    const late = load({ id: "l2", stops: [{ earliest: at(0), latest: at(60), arrivedAt: at(130) }, { earliest: at(6 * 60), latest: at(8 * 60), arrivedAt: at(7 * 60) }] });
    const card = driverScorecard([load(), late]);
    expect(card.onTime).toEqual({ scored: 4, onTime: 3, rate: 0.75 });
    expect(card.worstLateMinutes).toBe(70);
  });

  it("counts empty miles to the pickup and home, but not home when a load covers the way back", () => {
    const card = driverScorecard([load({ pickupDeadheadMiles: 20, loadedMiles: 260, returnDeadheadMiles: 20 }), load({ id: "l2", pickupDeadheadMiles: 30, loadedMiles: 200, returnDeadheadMiles: 999, isBackhaul: true })]);
    expect(card.empty.miles).toBe(20 + 20 + 30);
    expect(card.empty.total).toBe(300 + 230);
    expect(card.empty.share).toBeCloseTo(70 / 530, 6);
  });

  it("adds up the pay it estimates, to the cent, and treats a load with none as nothing", () => {
    expect(driverScorecard([load({ payEstimate: 130.1 }), load({ id: "l2", payEstimate: 99.95 }), load({ id: "l3", payEstimate: null })]).pay).toBe(230.05);
  });

  it("counts a customer who paid less than the invoice, and by how much", () => {
    const card = driverScorecard([load({ paidAmount: 940 }), load({ id: "l2", paidAmount: 1000 }), load({ id: "l3", paymentStatus: "invoiced", paidAmount: null }), load({ id: "l4", paidAmount: 1010 })]);
    expect(card.shortPaid).toEqual({ loads: 1, dollars: 60 });
    expect(card.perLoad.find((l) => l.id === "l1")!.shortBy).toBe(60);
  });
});
