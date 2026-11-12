import { describe, expect, test } from "vitest";
import { batonDigestText, dropProblems, handoffLevel, positioningPayEstimate, receiveProblems, relayBadge, waitMinutes, waitWords, HANDOFF_BLOCK_MINUTES, HANDOFF_WARN_MINUTES } from "@/lib/relay";

const GOOD = { type: "drop_hook", reason: "planned", locationName: "Albuquerque yard", outgoingNext: "bobtail" } as const;
const fields = (p: ReturnType<typeof dropProblems>) => p.map((x) => x.field);

describe("a drop (docs/RELAY_DESIGN.md)", () => {
  test("a complete drop has no problems", () => {
    expect(dropProblems(GOOD)).toEqual([]);
    expect(dropProblems({ ...GOOD, locationName: null, lat: 35.1, lng: -106.6, locationSetBy: "emergency_pin" })).toEqual([]);
  });
  test("it must say what kind, why, where, and what the outgoing driver does now (edge case A)", () => {
    expect(fields(dropProblems({ ...GOOD, type: "swap" }))).toEqual(["type"]);
    expect(fields(dropProblems({ ...GOOD, reason: "tired" }))).toEqual(["reason"]);
    expect(fields(dropProblems({ ...GOOD, locationName: "  " }))).toEqual(["location"]);
    expect(fields(dropProblems({ ...GOOD, outgoingNext: undefined }))).toEqual(["outgoingNext"]);
    expect(fields(dropProblems({ ...GOOD, outgoingNext: "go home" }))).toEqual(["outgoingNext"]);
  });
  test("a pin needs both coordinates, on the map", () => {
    expect(fields(dropProblems({ ...GOOD, lat: 35 }))).toEqual(["location"]);
    expect(fields(dropProblems({ ...GOOD, lat: 95, lng: 10 }))).toEqual(["location"]);
    expect(fields(dropProblems({ ...GOOD, lat: 10, lng: 200 }))).toEqual(["location"]);
  });
  test("miles come with where they came from, and a source never stands alone: no guessing", () => {
    expect(dropProblems({ ...GOOD, milesDriven: 412, milesSource: "eld" })).toEqual([]);
    expect(fields(dropProblems({ ...GOOD, milesDriven: 412 }))).toEqual(["miles"]);
    expect(fields(dropProblems({ ...GOOD, milesDriven: 412, milesSource: "i think" }))).toEqual(["miles"]);
    expect(fields(dropProblems({ ...GOOD, milesSource: "eld" }))).toEqual(["miles"]);
    expect(fields(dropProblems({ ...GOOD, milesDriven: -3, milesSource: "driver" }))).toEqual(["miles"]);
  });
  test("reefer numbers are sane", () => {
    expect(dropProblems({ ...GOOD, reeferSetTemp: -10, reeferActualTemp: -9.5, reeferFuelPct: 80 })).toEqual([]);
    expect(fields(dropProblems({ ...GOOD, reeferFuelPct: 120 }))).toEqual(["reefer"]);
    expect(fields(dropProblems({ ...GOOD, reeferSetTemp: 400 }))).toEqual(["reefer"]);
  });
});

describe("taking custody", () => {
  const base = { type: "drop_hook", tractorOutId: "T1", outDriverId: "D1", state: "dropped", discrepancyFlagged: false, ackAt: null as Date | null };
  test("a hook or a rescue is a different driver in a different truck", () => {
    expect(receiveProblems(base, { driverId: "D2", vehicleId: "T2" })).toEqual([]);
    expect(fields(receiveProblems(base, { driverId: "D1", vehicleId: "T2" }))).toEqual(["driver"]);
    expect(fields(receiveProblems(base, { driverId: "D2", vehicleId: "T1" }))).toEqual(["vehicle"]);
    expect(fields(receiveProblems(base, { driverId: "D2" }))).toEqual(["vehicle"]);
    expect(receiveProblems({ ...base, type: "rescue" }, { driverId: "D2", vehicleId: "T2" })).toEqual([]);
  });
  test("a swap keeps the same truck", () => {
    const swap = { ...base, type: "slip_seat" };
    expect(receiveProblems(swap, { driverId: "D2" })).toEqual([]);
    expect(receiveProblems(swap, { driverId: "D2", vehicleId: "T1" })).toEqual([]);
    expect(fields(receiveProblems(swap, { driverId: "D2", vehicleId: "T2" }))).toEqual(["vehicle"]);
  });
  test("a reported discrepancy has to be acknowledged first; a received baton is not taken twice", () => {
    expect(fields(receiveProblems({ ...base, state: "disputed", discrepancyFlagged: true }, { driverId: "D2", vehicleId: "T2" }))).toEqual(["state"]);
    expect(receiveProblems({ ...base, discrepancyFlagged: true, ackAt: new Date() }, { driverId: "D2", vehicleId: "T2" })).toEqual([]);
    expect(fields(receiveProblems({ ...base, state: "received" }, { driverId: "D2", vehicleId: "T2" }))).toEqual(["state"]);
  });
});

describe("pay for a positioning leg", () => {
  test("the driver's cents a mile times the miles, in cents; never a guess", () => {
    expect(positioningPayEstimate(42, 0.6)).toBe(25.2);
    expect(positioningPayEstimate(100.5, 0.55)).toBe(55.28); // 55.275 rounds up to the cent
    expect(positioningPayEstimate(null, 0.6)).toBeNull();
    expect(positioningPayEstimate(42, null)).toBeNull();
    expect(positioningPayEstimate(42, 0)).toBeNull();
    expect(positioningPayEstimate(-1, 0.6)).toBeNull();
  });
});

describe("how long a baton waits, and how loud it is", () => {
  const dropped = new Date("2026-11-06T12:00:00Z");
  const at = (m: number) => new Date(dropped.getTime() + m * 60_000);
  const h = (over: object = {}) => ({ state: "dropped", discrepancyFlagged: false, ackAt: null as Date | null, droppedAt: dropped, ...over });
  test("quiet, then a warning at an hour, then a block at four", () => {
    expect(handoffLevel(h(), at(HANDOFF_WARN_MINUTES - 1))).toBeNull();
    expect(handoffLevel(h(), at(HANDOFF_WARN_MINUTES))).toBe("warn");
    expect(handoffLevel(h(), at(HANDOFF_BLOCK_MINUTES - 1))).toBe("warn");
    expect(handoffLevel(h(), at(HANDOFF_BLOCK_MINUTES))).toBe("block");
  });
  test("an unacknowledged discrepancy is a block at once; acknowledged, it is only the wait; a received baton is quiet", () => {
    expect(handoffLevel(h({ state: "disputed", discrepancyFlagged: true }), at(1))).toBe("block");
    expect(handoffLevel(h({ discrepancyFlagged: true, ackAt: at(2) }), at(3))).toBeNull();
    expect(handoffLevel(h({ state: "received" }), at(999))).toBeNull();
  });
  test("the wait is whole minutes, never negative", () => {
    expect(waitMinutes(dropped, at(90.9))).toBe(90);
    expect(waitMinutes(dropped, at(-5))).toBe(0);
    expect(waitWords(45)).toBe("45 min");
    expect(waitWords(120)).toBe("2 h");
    expect(waitWords(135)).toBe("2 h 15 min");
  });
});

describe("the badge and the hash", () => {
  test("the board's badge says which leg and what is waiting", () => {
    expect(relayBadge(1, { state: "dropped", locationName: "Flagstaff #204" })).toBe("Relay · leg 1 of 2 · awaiting handoff at Flagstaff #204");
    expect(relayBadge(1, { state: "disputed", locationName: null })).toBe("Relay · leg 1 of 2 · handoff disputed");
    expect(relayBadge(2, null)).toBe("Relay · leg 2 of 2");
  });
  const baton = {
    loadId: "L1", type: "drop_hook", reason: "planned", outLegSeq: 1, locationName: "Yard", locationLat: null, locationLng: null, locationSlot: "12", locationSetBy: "dispatcher_typed", tractorOutId: "T1", tractorInId: null,
    trailerId: "TR1", outDriverId: "D1", inDriverId: null, sealNumber: "48291", sealMatches: null, reeferSetTemp: null, reeferActualTemp: null, reeferFuelPct: null, conditionOk: null, conditionNotes: null,
    discrepancyFlagged: false, discrepancyNotes: null, discrepancyBy: null, outgoingNext: "bobtail", droppedAt: new Date("2026-11-06T12:00:00Z"), droppedSource: "dispatcher", receivedAt: null, receivedSource: null, enteredBy: "Dispatcher"
  };
  test("the same baton always gives the same text, and any change to what it says changes it", () => {
    expect(batonDigestText(baton)).toBe(batonDigestText({ ...baton }));
    expect(batonDigestText({ ...baton, sealNumber: "48292" })).not.toBe(batonDigestText(baton));
    expect(batonDigestText({ ...baton, discrepancyFlagged: true })).not.toBe(batonDigestText(baton));
  });
});
