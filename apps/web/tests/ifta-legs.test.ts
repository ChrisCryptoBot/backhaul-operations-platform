import { describe, expect, test } from "vitest";
import { shareMiles, spreadLeg, truckLegs, type LegLoad } from "@/lib/ifta-legs";
import { countedRows, countedSource } from "@/lib/ifta-mileage";

/**
 * Wave 5 step 5b: a truck's quarter as legs to route, and the one rule every reader counts by (ELD first, per truck). Worked by hand.
 */
const at = (iso: string) => new Date(iso).getTime();
const load = (loadId: string, stops: Array<[number, string, string | null]>, completed: string | null, loaded: string, dh = "0"): LegLoad => ({
  loadId,
  stops: stops.map(([sequence, place, when]) => ({ sequence, place, at: when ? at(when) : null })),
  completedAt: completed ? at(completed) : null,
  loadedMiles: loaded,
  pickupDeadheadMiles: dh
});

describe("a truck's legs", () => {
  test("a multi-stop load is routed stop by stop in sequence order, whatever order the stops come in, and empty legs chain each delivery to the next pickup", () => {
    const a = load(
      "A",
      [
        [3, "Memphis, TN", "2026-07-02T18:00:00Z"],
        [1, "Dallas, TX", "2026-07-01T12:00:00Z"],
        [2, "Little Rock, AR", "2026-07-02T08:00:00Z"]
      ],
      "2026-07-02T19:00:00Z",
      "450"
    );
    const b = load(
      "B",
      [
        [1, "Nashville, TN", "2026-07-04T10:00:00Z"],
        [2, "Atlanta, GA", "2026-07-04T18:00:00Z"]
      ],
      "2026-07-04T18:30:00Z",
      "250",
      "210.25"
    );
    const out = truckLegs([b, a], "Dallas, TX");
    expect(out.legs.map((l) => [l.key, l.loaded, l.loadId, l.from, l.to, l.miles])).toEqual([
      ["l:A:1>2", true, "A", "Dallas, TX", "Little Rock, AR", "225.0"],
      ["l:A:2>3", true, "A", "Little Rock, AR", "Memphis, TN", "225.0"],
      ["e:A>B", false, null, "Memphis, TN", "Nashville, TN", "210.3"],
      ["l:B:1>2", true, "B", "Nashville, TN", "Atlanta, GA", "250.0"]
    ]);
    // Times: each leg leaves at its stop's time; the last loaded leg ends at completion; the empty leg runs from one delivery to the next pickup.
    expect(out.legs.map((l) => [new Date(l.startsAt).toISOString(), new Date(l.endsAt).toISOString()])).toEqual([
      ["2026-07-01T12:00:00.000Z", "2026-07-02T08:00:00.000Z"],
      ["2026-07-02T08:00:00.000Z", "2026-07-02T19:00:00.000Z"],
      ["2026-07-02T19:00:00.000Z", "2026-07-04T10:00:00.000Z"],
      ["2026-07-04T10:00:00.000Z", "2026-07-04T18:30:00.000Z"]
    ]);
    expect(out).toMatchObject({ noStart: [], untimed: [], tooFewStops: [] });
  });

  test("the first load starts from home only when it says there were empty miles; with no home base no leg is made up", () => {
    const first = load("A", [[1, "Tulsa, OK", "2026-07-01T12:00:00Z"], [2, "Dallas, TX", "2026-07-01T20:00:00Z"]], "2026-07-01T20:00:00Z", "260", "100");
    const fromHome = truckLegs([first], "Dallas, TX").legs[0]!;
    expect(fromHome).toMatchObject({ key: "e:home>A", loaded: false, loadId: null, from: "Dallas, TX", to: "Tulsa, OK", miles: "100.0", endsAt: at("2026-07-01T12:00:00Z") });
    expect(fromHome.endsAt - fromHome.startsAt).toBe(2 * 3_600_000); // 100 miles at 50 mph
    const noHome = truckLegs([first], null);
    expect(noHome.legs.map((l) => l.key)).toEqual(["l:A:1>2"]);
    expect(noHome.noStart).toEqual(["A"]);
    // No empty miles on the load: no leg from home, and nothing to report.
    expect(truckLegs([{ ...first, pickupDeadheadMiles: "0" }], null)).toMatchObject({ noStart: [], legs: [{ key: "l:A:1>2" }] });
    // Home is the pickup itself: no leg.
    expect(truckLegs([first], " tulsa,  ok ").legs.map((l) => l.key)).toEqual(["l:A:1>2"]);
  });

  test("no run home after the last load, a load with no time or one stop is reported, and the same place twice makes no leg", () => {
    const a = load("A", [[1, "Dallas, TX", "2026-07-01T12:00:00Z"], [2, "Dallas, TX", "2026-07-01T14:00:00Z"], [3, "Houston, TX", "2026-07-01T20:00:00Z"]], "2026-07-01T20:00:00Z", "240");
    const untimed = load("U", [[1, "Austin, TX", null], [2, "Waco, TX", null]], null, "100");
    const single = load("S", [[1, "Austin, TX", "2026-07-03T10:00:00Z"]], "2026-07-03T12:00:00Z", "0");
    const out = truckLegs([a, untimed, single], "Dallas, TX");
    expect(out.legs.map((l) => [l.key, l.miles])).toEqual([
      ["l:A:2>3", "240.0"],
      ["e:A>S", "0.0"]
    ]);
    expect(out.untimed).toEqual(["U"]);
    expect(out.tooFewStops).toEqual(["S"]);
  });

  test("a load's miles are shared by straight-line distance when every stop has a point, exact to a tenth", () => {
    const placed: LegLoad = {
      loadId: "P",
      completedAt: at("2026-07-02T00:00:00Z"),
      loadedMiles: "1000",
      pickupDeadheadMiles: "0",
      stops: [
        { sequence: 1, place: "Dallas, TX", at: at("2026-07-01T00:00:00Z"), lat: 32.7767, lng: -96.797 },
        { sequence: 2, place: "Houston, TX", at: null, lat: 29.7604, lng: -95.3698 },
        { sequence: 3, place: "Atlanta, GA", at: null, lat: 33.749, lng: -84.388 }
      ]
    };
    const legs = truckLegs([placed], null).legs;
    expect(legs.map((l) => l.miles)).toEqual(["242.7", "757.3"]); // about 225 and 700 miles as the crow flies
    // Untimed middle stop: the second leg starts where the first ended.
    expect(legs[1]!.startsAt).toBe(legs[0]!.endsAt);
    expect(legs[1]!.endsAt).toBe(at("2026-07-02T00:00:00Z"));
  });

  test("shareMiles adds up exactly; spreadLeg shares a leg's time by miles and drops empty states", () => {
    expect(shareMiles("100", [1, 1, 1])).toEqual(["33.3", "33.3", "33.4"]);
    expect(shareMiles("10", [0, 0])).toEqual(["5.0", "5.0"]);
    const p = spreadLeg({ startsAt: 0, endsAt: 10_000 }, [
      { state: "TX", miles: "30.0" },
      { state: "OK", miles: "0.0" },
      { state: "KS", miles: "70.0" }
    ]);
    expect(p).toEqual([
      { state: "TX", miles: "30.0", startedAt: 0, endedAt: 3000 },
      { state: "KS", miles: "70.0", startedAt: 3000, endedAt: 10_000 }
    ]);
  });
});

describe("ELD first, per truck", () => {
  const t1 = new Date("2026-10-01T00:00:00Z");
  const t2 = new Date("2026-10-02T00:00:00Z");
  test("a truck with ELD rows counts only those, whichever was read last; one with none counts its routed rows", () => {
    const chosen = countedSource([
      { vehicleId: "a", method: "routed", source: "promiles", syncedAt: t2 },
      { vehicleId: "a", method: "eld", source: "motive", syncedAt: t1 },
      { vehicleId: "b", method: "routed", source: "promiles", syncedAt: t1 },
      { vehicleId: "c", method: "eld", source: "motive", syncedAt: t1 },
      { vehicleId: "c", method: "eld", source: "samsara", syncedAt: t2 },
      { vehicleId: "d", method: "guess", source: "x", syncedAt: t2 }
    ]);
    expect([...chosen].sort()).toEqual([
      ["a", { method: "eld", source: "motive" }],
      ["b", { method: "routed", source: "promiles" }],
      ["c", { method: "eld", source: "samsara" }]
    ]);
    const rows = [
      { vehicleId: "a", method: "eld", source: "motive", miles: 10 },
      { vehicleId: "a", method: "routed", source: "promiles", miles: 11 },
      { vehicleId: "b", method: "routed", source: "promiles", miles: 20 },
      { vehicleId: "c", method: "eld", source: "motive", miles: 30 },
      { vehicleId: "c", method: "eld", source: "samsara", miles: 31 }
    ];
    expect(countedRows(rows, chosen).map((r) => r.miles)).toEqual([10, 20, 31]);
  });
});
