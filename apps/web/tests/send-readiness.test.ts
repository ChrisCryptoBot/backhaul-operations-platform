import { describe, expect, it } from "vitest";
import { gapsPhrase, refList, sendReadiness, type SendReadinessInput } from "../src/lib/send-readiness";

const ready: SendReadinessInput = {
  weightLbs: 12000,
  loadNumber: "L-100",
  pickupRefs: ["PU 4471"],
  trailerType: "dry_van",
  vehicleType: "heavy_duty",
  pickupTime: new Date("2027-03-01T14:00:00Z"),
  deliveryTime: new Date("2027-03-02T14:00:00Z")
};

describe("what a load still lacks before it is sent", () => {
  it("lists nothing for a complete load", () => {
    expect(sendReadiness(ready)).toEqual([]);
  });

  it("names what the phone would stop a driver on: weight, load number, pickup number", () => {
    const gaps = sendReadiness({ ...ready, weightLbs: null, loadNumber: " ", pickupRefs: [] });
    expect(gaps.map((g) => g.key)).toEqual(["weight", "loadNumber", "pickupNumber"]);
  });

  it("asks for the trailer only for a truck that pulls one", () => {
    expect(sendReadiness({ ...ready, trailerType: null }).map((g) => g.key)).toEqual(["trailer"]);
    expect(sendReadiness({ ...ready, trailerType: null, vehicleType: "cargo_van" })).toEqual([]);
  });

  it("adds the two times, which the phone does not ask for", () => {
    const gaps = sendReadiness({ ...ready, pickupTime: null, deliveryTime: null });
    expect(gaps.map((g) => g.key)).toEqual(["pickupTime", "deliveryTime"]);
  });

  it("says it in a sentence", () => {
    expect(gapsPhrase([])).toBe("");
    expect(gapsPhrase(sendReadiness({ ...ready, weightLbs: null }))).toBe("weight");
    expect(gapsPhrase(sendReadiness({ ...ready, weightLbs: null, pickupRefs: [] }))).toBe("weight and pickup number");
    expect(gapsPhrase(sendReadiness({ ...ready, weightLbs: null, pickupRefs: [], pickupTime: null }))).toBe("weight, pickup number and pickup time");
  });

  it("reads a stored list of numbers, ignoring anything that is not text", () => {
    expect(refList(["A1", " ", 7, "B2"])).toEqual(["A1", "B2"]);
    expect(refList(null)).toEqual([]);
    expect(refList("A1")).toEqual([]);
  });
});
