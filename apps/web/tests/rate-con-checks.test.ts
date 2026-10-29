import { describe, expect, it } from "vitest";
import { firstOutOfOrder, needsStopCheck, rateConChecks, type CheckStop } from "../src/lib/rate-con-checks";

const NOW = Date.parse("2026-10-29T15:00:00Z");
const at = (iso: string) => iso;
const stop = (type: string, address: string, earliest: string | null, latest: string | null = earliest): CheckStop => ({ stopType: type, addressString: address, timeWindowEarliest: earliest, timeWindowLatest: latest });
const PICK = stop("pickup", "100 Dock Rd, Dallas, TX 75201", at("2026-10-30T14:00:00Z"), at("2026-10-30T16:00:00Z"));
const DROP = stop("delivery", "9 Main St, Memphis, TN 38103", at("2026-10-31T14:00:00Z"), at("2026-10-31T18:00:00Z"));
const ids = (stops: CheckStop[], miles: number | null = 450) => rateConChecks({ stops, loadedMiles: miles, nowMs: NOW }).map((c) => c.id);

describe("rate-con review checks", () => {
  it("a clean two-stop load raises nothing", () => {
    expect(ids([PICK, DROP])).toEqual([]);
    expect(needsStopCheck(rateConChecks({ stops: [PICK, DROP], loadedMiles: 450, nowMs: NOW }))).toBe(false);
  });

  it("flags a stop due before an earlier stop, naming both places", () => {
    const early = stop("delivery", "9 Main St, Memphis, TN 38103", at("2026-10-29T14:00:00Z"), at("2026-10-29T18:00:00Z"));
    expect(firstOutOfOrder([PICK, early])).toEqual([0, 1]);
    const checks = rateConChecks({ stops: [PICK, early], loadedMiles: 450, nowMs: NOW });
    const order = checks.find((c) => c.id === "order")!;
    expect(order.level).toBe("confirm");
    expect(order.text).toContain("Memphis, TN");
    expect(order.text).toContain("Dallas, TX");
    expect(needsStopCheck(checks)).toBe(true);
  });

  it("does not call touching windows out of order", () => {
    const same = stop("delivery", "9 Main St, Memphis, TN 38103", at("2026-10-30T14:00:00Z"), at("2026-10-30T16:00:00Z"));
    expect(firstOutOfOrder([PICK, same])).toBeNull();
  });

  it("wants a pickup first and a delivery last", () => {
    expect(ids([DROP, PICK])).toContain("first");
    expect(ids([DROP, PICK])).toContain("last");
    expect(ids([PICK, PICK])).toContain("last");
  });

  it("asks for a check of three or more stops, once", () => {
    const mid = stop("pickup", "5 Oak Ave, Little Rock, AR 72201", at("2026-10-30T20:00:00Z"));
    const found = ids([PICK, mid, DROP]).filter((x) => x === "many");
    expect(found).toHaveLength(1);
  });

  it("cautions about a date in the past, a backwards window, a missing appointment and missing miles, without needing a confirm", () => {
    const old = stop("pickup", "100 Dock Rd, Dallas, TX 75201", at("2025-10-30T14:00:00Z"), at("2025-10-30T16:00:00Z"));
    const backwards = stop("delivery", "9 Main St, Memphis, TN 38103", at("2026-10-31T18:00:00Z"), at("2026-10-31T14:00:00Z"));
    const none = stop("delivery", "9 Main St, Memphis, TN 38103", null, null);
    expect(ids([old, DROP])).toContain("past");
    expect(ids([PICK, backwards])).toContain("window1");
    expect(ids([PICK, none])).toContain("appt1");
    expect(ids([PICK, DROP], null)).toContain("miles");
    expect(needsStopCheck(rateConChecks({ stops: [old, none], loadedMiles: null, nowMs: NOW }))).toBe(false);
  });

  it("an appointment from earlier today is not in the past", () => {
    const today = stop("pickup", "100 Dock Rd, Dallas, TX 75201", at("2026-10-29T08:00:00Z"));
    expect(ids([today, DROP])).not.toContain("past");
  });

  it("nothing to check without stops", () => {
    expect(rateConChecks({ stops: [], loadedMiles: null, nowMs: NOW })).toEqual([]);
  });
});
