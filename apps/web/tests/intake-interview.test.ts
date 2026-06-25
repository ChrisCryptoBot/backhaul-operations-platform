import { describe, expect, test } from "vitest";
import {
  advanceIntake,
  seedFromExtractedPayload,
  startIntake,
  type IntakeResult,
  type IntakeSeed
} from "@/server/copilot/intake-interview";

/** Drive the interview by feeding answers in order; stops at `done`. */
function run(answers: string[], seed: IntakeSeed = {}): IntakeResult {
  let res = startIntake(seed);
  for (const a of answers) {
    res = advanceIntake(res.state, a);
    if (res.done) break;
  }
  return res;
}

describe("intake interview — start", () => {
  test("opens by asking the relay leg count", () => {
    const res = startIntake();
    expect(res.state.step).toBe("leg_count");
    expect(res.prompt).toMatch(/how many relay legs/i);
    expect(res.done).toBeUndefined();
  });

  test("a seed never short-circuits the relay plan (always asks leg count first)", () => {
    const res = startIntake({ pickupCity: "X", pickupState: "PA", lineHaulRate: "1000" });
    expect(res.state.step).toBe("leg_count");
  });
});

describe("intake interview — full happy path", () => {
  test("a 3-leg full relay with no seed collects everything and stages create_relayed_load", () => {
    const res = run([
      "3",
      "SHUTTLE", "Ann",
      "PTP", "Bob",
      "DELIVERY", "Cal",
      "Allentown, PA",
      "Columbus, OH",
      "1850",
      "yes",
      "10",
      "12",
      "500"
    ]);
    expect(res.done).toBeDefined();
    const done = res.done!;
    expect(done.tool).toBe("create_relayed_load");
    expect(done.input).toMatchObject({
      pickupCity: "Allentown",
      pickupState: "PA",
      deliveryCity: "Columbus",
      deliveryState: "OH",
      lineHaulRate: "1850",
      fscApplies: true,
      puDeadheadMiles: "10",
      delDeadheadMiles: "12",
      loadedMiles: "500"
    });
    expect(done.input.legs).toEqual([
      { legIndex: 0, legType: "SHUTTLE", driverName: "Ann" },
      { legIndex: 1, legType: "PTP", driverName: "Bob" },
      { legIndex: 2, legType: "DELIVERY", driverName: "Cal" }
    ]);
    expect(done.summary).toContain("3 legs");
    expect(done.summary).toContain("3/3 legs covered");
  });

  test("a 1-leg direct load needs no handoff and stages a single leg", () => {
    const res = run([
      "1",
      "PTP", "Dan",
      "Reading, PA",
      "Newark, NJ",
      "1200",
      "no",
      "5",
      "5",
      "250"
    ]);
    expect(res.done).toBeDefined();
    expect(res.done!.input.legs).toEqual([{ legIndex: 0, legType: "PTP", driverName: "Dan" }]);
    expect(res.done!.input.fscApplies).toBe(false);
    expect(res.done!.summary).toContain("1 leg ");
  });
});

describe("intake interview — seeding skips known base fields", () => {
  test("a rate-con seed only asks the relay plan + deadheads/FSC", () => {
    const seed: IntakeSeed = {
      pickupCity: "Allentown",
      pickupState: "PA",
      deliveryCity: "Columbus",
      deliveryState: "OH",
      lineHaulRate: "1000",
      loadedMiles: "400"
    };
    // Only: leg count, one leg (type+driver), fsc, pu_dh, del_dh.
    const res = run(["1", "PTP", "Dan", "no", "5", "6"], seed);
    expect(res.done).toBeDefined();
    expect(res.done!.input).toMatchObject({
      pickupCity: "Allentown",
      lineHaulRate: "1000",
      loadedMiles: "400",
      puDeadheadMiles: "5",
      delDeadheadMiles: "6",
      fscApplies: false
    });
  });
});

describe("seedFromExtractedPayload — rate-con payload → interview seed", () => {
  test("splits combined city/state and maps the fields a rate con carries", () => {
    const seed = seedFromExtractedPayload({
      originCityState: "Allentown, PA",
      destinationCityState: "Columbus, OH",
      lineHaulRate: "1850",
      loadedMiles: "500",
      brokerName: "Acme Logistics",
      shipperName: "Shipper Co",
      receiverName: "Receiver Co",
      // fields the seed does not carry (deadheads/FSC) are ignored
      pickupNumber: "PU123",
      pickupDate: "2026-06-25"
    });
    expect(seed).toEqual({
      pickupCity: "Allentown",
      pickupState: "PA",
      deliveryCity: "Columbus",
      deliveryState: "OH",
      lineHaulRate: "1850",
      loadedMiles: "500",
      brokerName: "Acme Logistics",
      shipperName: "Shipper Co",
      receiverName: "Receiver Co"
    });
  });

  test("is defensive: a partial / malformed payload seeds only the valid fields", () => {
    const seed = seedFromExtractedPayload({
      originCityState: "Allentown", // no comma → not split, not seeded
      lineHaulRate: "not-a-number", // fails the decimal guard
      loadedMiles: "400",
      brokerName: "   " // blank → skipped
    });
    expect(seed).toEqual({ loadedMiles: "400" });
  });

  test("a seeded interview skips the pre-filled questions and stages create_relayed_load", () => {
    const seed = seedFromExtractedPayload({
      originCityState: "Allentown, PA",
      destinationCityState: "Columbus, OH",
      lineHaulRate: "1850",
      loadedMiles: "500",
      brokerName: "Acme Logistics"
    });
    // Only the relay plan + deadheads + FSC remain to ask.
    const res = run(["1", "PTP", "Dan", "no", "5", "6"], seed);
    expect(res.done).toBeDefined();
    expect(res.done!.input).toMatchObject({
      pickupCity: "Allentown",
      pickupState: "PA",
      deliveryCity: "Columbus",
      deliveryState: "OH",
      lineHaulRate: "1850",
      loadedMiles: "500",
      brokerName: "Acme Logistics",
      puDeadheadMiles: "5",
      delDeadheadMiles: "6",
      fscApplies: false
    });
  });
});

describe("intake interview — rate-con linkage rides through to the staged action", () => {
  test("a seeded rateConfirmationId surfaces in the staged create_relayed_load input", () => {
    const res = run(
      ["1", "PTP", "Dan", "Reading, PA", "Newark, NJ", "1200", "no", "5", "5", "250"],
      { rateConfirmationId: "rc_abc123" }
    );
    expect(res.done).toBeDefined();
    expect(res.done!.input.rateConfirmationId).toBe("rc_abc123");
  });

  test("no rateConfirmationId seeded → the staged input omits it", () => {
    const res = run(["1", "PTP", "Dan", "Reading, PA", "Newark, NJ", "1200", "no", "5", "5", "250"]);
    expect(res.done!.input.rateConfirmationId).toBeUndefined();
  });
});

describe("intake interview — step rail + quick replies", () => {
  test("opens at step 1 with no total yet (leg count unknown) and 1–4 reply chips", () => {
    const res = startIntake();
    expect(res.stepNo).toBe(1);
    expect(res.stepTotal).toBeUndefined();
    expect(res.replies?.map((r) => r.value)).toEqual(["1", "2", "3", "4"]);
  });

  test("once leg count is known, total is exact and leg-type chips appear", () => {
    const res = advanceIntake(startIntake().state, "3");
    expect(res.state.step).toBe("leg_0_type");
    expect(res.stepNo).toBe(2);
    // 1 leg_count + 3 legs × (type + driver) + 7 base questions = 14
    expect(res.stepTotal).toBe(14);
    expect(res.replies?.map((r) => r.value)).toEqual(["SHUTTLE", "PTP", "DELIVERY"]);
  });

  test("a seed shrinks the total to only the questions still asked", () => {
    const seed: IntakeSeed = {
      pickupCity: "Allentown", pickupState: "PA",
      deliveryCity: "Columbus", deliveryState: "OH",
      lineHaulRate: "1850", loadedMiles: "412"
    };
    // 1 leg → 1 leg_count + 1 leg × (type + driver) + 3 base (fsc, pu_dh, del_dh) = 6
    const res = advanceIntake(startIntake(seed).state, "1");
    expect(res.stepTotal).toBe(6);
  });

  test("fsc step offers yes/no chips", () => {
    const atFsc = run(["1", "PTP", "Dan", "Reading, PA", "Newark, NJ", "1200"]);
    expect(atFsc.state.step).toBe("fsc");
    expect(atFsc.replies?.map((r) => r.value)).toEqual(["yes", "no"]);
  });

  test("an invalid answer re-shows the same step's chips and position", () => {
    const bad = advanceIntake(startIntake().state, "9");
    expect(bad.error).toBeTruthy();
    expect(bad.stepNo).toBe(1);
    expect(bad.replies?.map((r) => r.value)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("intake interview — validation re-asks the same step", () => {
  test("leg count must be 1-4", () => {
    const bad = advanceIntake(startIntake().state, "9");
    expect(bad.error).toBeTruthy();
    expect(bad.state.step).toBe("leg_count");
    const ok = advanceIntake(bad.state, "2");
    expect(ok.error).toBeUndefined();
    expect(ok.state.step).toBe("leg_0_type");
  });

  test("leg type must be a known driver type", () => {
    const afterCount = advanceIntake(startIntake().state, "1");
    const bad = advanceIntake(afterCount.state, "boat");
    expect(bad.error).toMatch(/SHUTTLE/);
    expect(bad.state.step).toBe("leg_0_type");
  });

  test("city/state must be City, ST", () => {
    let res = run(["1", "PTP", "Dan"]); // stops at the pickup prompt (no done)
    expect(res.state.step).toBe("pickup");
    const bad = advanceIntake(res.state, "Allentown");
    expect(bad.error).toMatch(/City, ST/i);
    expect(bad.state.step).toBe("pickup");
  });

  test("numeric fields reject non-numbers; fsc requires yes/no", () => {
    const atRate = run(["1", "PTP", "Dan", "Reading, PA", "Newark, NJ"]);
    expect(atRate.state.step).toBe("rate");
    const badRate = advanceIntake(atRate.state, "lots");
    expect(badRate.error).toBeTruthy();
    expect(badRate.state.step).toBe("rate");

    const atFsc = advanceIntake(atRate.state, "1200");
    expect(atFsc.state.step).toBe("fsc");
    const badFsc = advanceIntake(atFsc.state, "maybe");
    expect(badFsc.error).toMatch(/yes or no/i);
    expect(badFsc.state.step).toBe("fsc");
  });
});

describe("intake interview — unassigned legs", () => {
  test('an "unassigned" driver answer stores null (a stall the board will flag later)', () => {
    const res = run([
      "2",
      "SHUTTLE", "unassigned",
      "PTP", "Bob",
      "Reading, PA",
      "Newark, NJ",
      "1200",
      "no",
      "5",
      "5",
      "250"
    ]);
    expect(res.done!.input.legs).toEqual([
      { legIndex: 0, legType: "SHUTTLE", driverName: null },
      { legIndex: 1, legType: "PTP", driverName: "Bob" }
    ]);
    expect(res.done!.summary).toContain("1/2 legs covered");
  });
});
