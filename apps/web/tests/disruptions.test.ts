import { describe, expect, test } from "vitest";
import { CAN_CANCEL, CAN_RESCHEDULE, CAN_TONU, CANCEL_REASONS, isCancelReason, isRescheduleReason, reasonLabel, RESCHEDULE_REASONS, shiftStops } from "../src/lib/disruptions";
import { summarizeDetention, type DetentionInput } from "../src/lib/detention";

describe("disruption reasons", () => {
  test("the picklist is the eight reasons a load falls through, each with a key and plain words", () => {
    expect(CANCEL_REASONS.map((r) => r.key)).toEqual(["driver_no_show", "equipment", "weather_road", "broker_cancelled", "shipper_not_ready", "rate_dispute", "pulled", "other"]);
    for (const r of [...CANCEL_REASONS, ...RESCHEDULE_REASONS]) expect(r.label.length).toBeGreaterThan(3);
    expect(isCancelReason("broker_cancelled")).toBe(true);
    expect(isCancelReason("broker_request")).toBe(false); // a reschedule reason is not a cancel reason
    expect(isRescheduleReason("broker_request")).toBe(true);
    expect(isRescheduleReason("rate_dispute")).toBe(false);
  });

  test("labels read back, and an unknown or missing reason is said plainly", () => {
    expect(reasonLabel("weather_road")).toBe("Weather or road closure");
    expect(reasonLabel("mystery")).toBe("mystery");
    expect(reasonLabel(null)).toBe("No reason given");
  });

  test("which statuses allow which action: a TONU needs a driver already on the way, a reschedule needs a load not yet moving", () => {
    expect(CAN_CANCEL).toEqual(["draft", "accepted", "in_progress"]);
    expect(CAN_TONU).toEqual(["accepted", "in_progress"]);
    expect(CAN_RESCHEDULE).toEqual(["draft", "accepted"]);
  });

  test("moving a pickup moves every stop by the same amount and leaves the gaps alone", () => {
    const h = 3_600_000;
    const stops = [
      { id: "a", timeWindowEarliest: new Date(8 * h), timeWindowLatest: new Date(11 * h) },
      { id: "b", timeWindowEarliest: new Date(32 * h), timeWindowLatest: new Date(36 * h) },
      { id: "c", timeWindowEarliest: null, timeWindowLatest: null }
    ];
    const moved = shiftStops(stops, 24 * h);
    expect(moved[0]!.timeWindowEarliest).toEqual(new Date(32 * h));
    expect(moved[1]!.timeWindowLatest).toEqual(new Date(60 * h));
    expect(moved[2]).toEqual({ id: "c", timeWindowEarliest: null, timeWindowLatest: null });
    expect(moved[1]!.timeWindowEarliest!.getTime() - moved[0]!.timeWindowEarliest!.getTime()).toBe(24 * h);
    expect(stops[0]!.timeWindowEarliest).toEqual(new Date(8 * h)); // the original is untouched
  });
});

describe("detention to recover", () => {
  const base = (over: Partial<DetentionInput> = {}): DetentionInput => ({
    stops: [
      { stopSequence: 1, stopType: "pickup", waitMinutes: 180 },
      { stopSequence: 2, stopType: "delivery", waitMinutes: 90 }
    ],
    dockWaitMinutes: null,
    rate: 60,
    graceMinutes: 120,
    workspaceGraceMinutes: 90,
    invoice: { invoiced: false, invoicedAmount: null, quotedRevenue: 1000, fuelSurcharge: 0 },
    ...over
  });

  test("each stop has its own free time: only the wait beyond it is billable, at the truck's hourly rate", () => {
    const d = summarizeDetention(base());
    expect(d).toMatchObject({ basis: "per_stop", graceMinutes: 120, totalWaitMinutes: 270, billableMinutes: 60, billable: 60, unbilled: 60, billedExtra: 0, noRate: false });
    expect(d.stops.map((s) => s.billableMinutes)).toEqual([60, 0]);
  });

  test("a truck with no free time of its own uses the workspace's", () => {
    const d = summarizeDetention(base({ graceMinutes: null }));
    expect(d.graceMinutes).toBe(90);
    expect(d.billableMinutes).toBe(90); // 180 - 90 at the pickup; the 90-minute delivery is exactly free
  });

  test("waits inside the free time bill nothing", () => {
    expect(summarizeDetention(base({ stops: [{ stopSequence: 1, stopType: "pickup", waitMinutes: 100 }, { stopSequence: 2, stopType: "delivery", waitMinutes: 30 }] }))).toMatchObject({ billable: 0, unbilled: 0 });
    expect(summarizeDetention(base({ stops: [], dockWaitMinutes: null })).billable).toBe(0);
  });

  test("an invoice that already carried detention leaves only the rest unbilled; one that carried none leaves it all", () => {
    expect(summarizeDetention(base({ invoice: { invoiced: true, invoicedAmount: 1060, quotedRevenue: 1000, fuelSurcharge: 0 } }))).toMatchObject({ billedExtra: 60, unbilled: 0 });
    expect(summarizeDetention(base({ invoice: { invoiced: true, invoicedAmount: 1030, quotedRevenue: 1000, fuelSurcharge: 0 } }))).toMatchObject({ billedExtra: 30, unbilled: 30 });
    expect(summarizeDetention(base({ invoice: { invoiced: true, invoicedAmount: 1000, quotedRevenue: 1000, fuelSurcharge: 0 } }))).toMatchObject({ billedExtra: 0, unbilled: 60 });
  });

  test("without a rate nothing can be billed, and that is said, not hidden", () => {
    expect(summarizeDetention(base({ rate: null }))).toMatchObject({ rate: 0, billable: 0, unbilled: 0, noRate: true });
    // no wait past the free time, so no rate is needed to say so
    expect(summarizeDetention(base({ rate: null, stops: [{ stopSequence: 1, stopType: "pickup", waitMinutes: 60 }] })).noRate).toBe(false);
  });
});
