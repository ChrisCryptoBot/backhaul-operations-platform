import { describe, expect, test } from "vitest";
import { deriveAlerts, RULES, type AlertLoad } from "../src/lib/alerts";

const NOW = new Date("2026-10-28T15:00:00Z");
const H = 3_600_000;
const D = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const driver = { id: "d1", name: "Alex Rivera", cdlExpiry: at(200 * D), medicalCardExpiry: at(200 * D) };

function load(over: Partial<AlertLoad> = {}): AlertLoad {
  return {
    id: "l1",
    loadNumber: "DM-1",
    status: "draft",
    paymentStatus: null,
    invoiceNumber: null,
    invoicedAt: null,
    payTermsDays: 30,
    verdict: "accept",
    stops: [
      { timeWindowEarliest: at(3 * D), timeWindowLatest: at(3 * D + 3 * H), referenceNumbers: ["PU-1"] },
      { timeWindowEarliest: at(4 * D), timeWindowLatest: at(4 * D + 3 * H), referenceNumbers: ["DEL-1"] }
    ],
    assignment: null,
    ...over
  };
}
const road = (over: Partial<AlertLoad> = {}) => load({ status: "in_progress", assignment: { status: "in_progress", dispatchedAt: at(-2 * D), driver }, ...over });
const codes = (loads: AlertLoad[]) => deriveAlerts(loads, NOW).map((a) => a.code);

describe("a load with no truck", () => {
  test("is flagged on an open load, because there is no cost floor and so no verdict", () => {
    const out = deriveAlerts([load({ hasTruck: false })], NOW);
    expect(out.map((a) => [a.code, a.level])).toEqual([["NO_TRUCK", "warn"]]);
    expect(out[0]!.message).toMatch(/no cost floor/i);
    expect(codes([load({ hasTruck: false, status: "accepted", assignment: { status: "accepted", dispatchedAt: at(-D), driver } })])).toContain("NO_TRUCK");
  });

  test("is not flagged when it has one, when that is not said, or when the load is closed", () => {
    expect(codes([load({ hasTruck: true })])).not.toContain("NO_TRUCK");
    expect(codes([load()])).not.toContain("NO_TRUCK"); // absent reads as having one
    for (const status of ["completed", "cancelled", "tonu"]) expect(codes([load({ status, hasTruck: false })])).not.toContain("NO_TRUCK");
  });
});

describe("a load that is late on the road", () => {
  test("is flagged once the last delivery window has closed and it is still not delivered", () => {
    const late = road({
      stops: [
        { timeWindowEarliest: at(-3 * D), timeWindowLatest: at(-3 * D + 2 * H), referenceNumbers: ["PU-1"] },
        { timeWindowEarliest: at(-1 * D), timeWindowLatest: at(-1 * D + 4 * H), referenceNumbers: ["DEL-1"] }
      ]
    });
    const out = deriveAlerts([late], NOW);
    const a = out.find((x) => x.code === "LATE_ON_ROAD")!;
    expect(a.level).toBe("warn");
    expect(a.message).toMatch(/delivery window closed 20 h ago/);
  });

  test("says days once it is more than a day", () => {
    const days = road({ stops: [{ timeWindowEarliest: at(-4 * D), timeWindowLatest: at(-3 * D), referenceNumbers: ["PU-1"] }, { timeWindowEarliest: at(-3 * D), timeWindowLatest: at(-2 * D), referenceNumbers: ["DEL-1"] }] });
    expect(deriveAlerts([days], NOW).find((x) => x.code === "LATE_ON_ROAD")!.message).toMatch(/closed 2 d ago/);
  });

  test("is not flagged while a window is still open, for a load not on the road, or for one with no times", () => {
    expect(codes([road()])).not.toContain("LATE_ON_ROAD"); // the delivery is days away
    const pastButNotStarted = load({
      status: "accepted",
      assignment: { status: "accepted", dispatchedAt: at(-D), driver },
      stops: [{ timeWindowEarliest: at(-2 * D), timeWindowLatest: at(-D), referenceNumbers: ["PU-1"] }, { timeWindowEarliest: at(-D), timeWindowLatest: at(-H), referenceNumbers: ["DEL-1"] }]
    });
    expect(codes([pastButNotStarted])).not.toContain("LATE_ON_ROAD");
    expect(codes([road({ stops: [{ timeWindowEarliest: null, timeWindowLatest: null, referenceNumbers: ["A"] }] })])).not.toContain("LATE_ON_ROAD");
  });

  test("judges the final stop only, and a final stop with no closing time has no deadline", () => {
    const openingOnly = road({ stops: [{ timeWindowEarliest: at(-3 * D), timeWindowLatest: at(-3 * D + H), referenceNumbers: ["PU"] }, { timeWindowEarliest: at(-2 * H), timeWindowLatest: null, referenceNumbers: ["DEL"] }] });
    expect(codes([openingOnly])).not.toContain("LATE_ON_ROAD"); // the pickup closed days ago, but nothing says when the delivery is due
  });
});

describe("the catalogue", () => {
  test("lists both rules, each with a sentence that ends in a full stop", () => {
    for (const code of ["NO_TRUCK", "LATE_ON_ROAD"]) {
      const rule = RULES.find((r) => r.code === code)!;
      expect(rule.level).toBe("warn");
      expect(rule.trigger({ pickupHours: 24, sentNoAnswerHours: 4, clearanceDays: 30 })).toMatch(/\.$/);
    }
  });
});
