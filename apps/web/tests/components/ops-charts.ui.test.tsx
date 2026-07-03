import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import {
  DeadheadRadiusLine,
  DeadheadSplitChart,
  DisruptionBreakdownChart,
  GrowthBars,
  OpsReliabilityTab,
  RateVarianceHistogramChart,
  ShuttleLeaderboard
} from "@/components/kpi/ops-charts";
import type { KpiOpsAnalytics } from "@/contracts/kpi";

afterEach(() => cleanup());

const rows = [
  { key: "name:A", driverId: null, driverName: "A. Low", deadheadMiles: 40, loadedMiles: 400, emptyPct: 9.1 },
  { key: "name:B", driverId: null, driverName: "B. Mid", deadheadMiles: 60, loadedMiles: 300, emptyPct: 16.7 },
  { key: "name:C", driverId: null, driverName: "C. High", deadheadMiles: 90, loadedMiles: 200, emptyPct: 31.0 }
];

describe("ShuttleLeaderboard", () => {
  test("ranks worst-first by empty % and labels the verdict", () => {
    render(<ShuttleLeaderboard rows={rows} emptyPctAmber={15} emptyPctRed={25} />);
    const names = screen.getAllByText(/Low|Mid|High/).map((n) => n.textContent);
    expect(names).toEqual(["C. High", "B. Mid", "A. Low"]); // 31% > 16.7% > 9.1%
    expect(screen.getByText("OVER RED")).toBeInTheDocument(); // 31% ≥ red 25
    expect(screen.getByText("WATCH")).toBeInTheDocument(); // 16.7% ≥ amber 15
    expect(screen.getByText("OK")).toBeInTheDocument(); // 9.1% < amber
  });

  test("toggles between Empty % and Deadhead mi", async () => {
    const user = userEvent.setup();
    render(<ShuttleLeaderboard rows={rows} emptyPctAmber={15} emptyPctRed={25} />);
    expect(screen.getByText("31.0%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deadhead mi" }));
    expect(screen.getByText("90 mi")).toBeInTheDocument();
    expect(screen.queryByText("31.0%")).not.toBeInTheDocument();
  });

  test("shows an empty state when there are no shuttle legs", () => {
    render(<ShuttleLeaderboard rows={[]} emptyPctAmber={15} emptyPctRed={25} />);
    expect(screen.getByText(/nothing to attribute/i)).toBeInTheDocument();
  });
});

describe("DeadheadSplitChart", () => {
  test("renders controllable and expected rows", () => {
    render(
      <DeadheadSplitChart
        split={{ controllable: { pickupDh: 84, deliveryDh: 105 }, expected: { pickupDh: 420, deliveryDh: 525 } }}
      />
    );
    expect(screen.getByText(/Controllable/)).toBeInTheDocument();
    expect(screen.getByText(/Expected/)).toBeInTheDocument();
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByText("525")).toBeInTheDocument();
  });
});

describe("DeadheadRadiusLine", () => {
  test("shows an empty state with fewer than two weeks", () => {
    render(<DeadheadRadiusLine points={[{ weekIso: "2026-W25", avgRadius: 30, loadCount: 3 }]} />);
    expect(screen.getByText(/Not enough weeks/i)).toBeInTheDocument();
  });

  test("plots a line when there are enough weeks", () => {
    const { container } = render(
      <DeadheadRadiusLine
        points={[
          { weekIso: "2026-W24", avgRadius: 20, loadCount: 2 },
          { weekIso: "2026-W25", avgRadius: 35, loadCount: 3 }
        ]}
      />
    );
    expect(container.querySelector("svg path")).toBeTruthy();
  });
});

const opsFixture: KpiOpsAnalytics = {
  config: { emptyPctAmber: 15, emptyPctRed: 25, onTimeTargetPct: 95 },
  shuttleLeaderboard: [],
  deadheadSplit: { controllable: { pickupDh: 0, deliveryDh: 0 }, expected: { pickupDh: 0, deliveryDh: 0 } },
  deadheadRadius: [],
  rateVarianceHistogram: { bins: [], median: null, count: 0, binSize: 100 },
  reliability: {
    otd: { onTime: 19, total: 20, unverified: 3 },
    otp: { onTime: 18, total: 20, unverified: 2 },
    firmAppt: { onTime: 9, total: 10, unverified: 1 },
    missed: { missed: 1, total: 20, unverified: 3 }
  },
  disruptionBreakdown: {
    reasons: [
      { reason: "CARRIER_NO_SHOW", label: "Carrier no-show", cancel: 3, reschedule: 1 },
      { reason: "NO_DOCK_TIME", label: "No dock time available", cancel: 0, reschedule: 2 },
      { reason: "WEATHER_ROAD", label: "Weather / road conditions", cancel: 0, reschedule: 0 }
    ],
    totalCancel: 3,
    totalReschedule: 3,
    trackedFromWeekIso: "2026-W20"
  },
  growth: {
    loadCount: { current: 120, prior: 100, pct: 20 },
    lineHaulRevenue: { current: 11000, prior: 12000, pct: -8.3 }
  }
};

describe("OpsReliabilityTab", () => {
  test("shows on-time % of verified with a pass check and hides zero-event reasons", () => {
    render(<OpsReliabilityTab ops={opsFixture} />);
    // OTD 19/20 = 95% ≥ target 95 → pass ✓
    expect(screen.getByText("95.0%")).toBeInTheDocument();
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
    // Missed 1/20 = 5% > target 2 (lower is better) → fail ✗ (OTP/firm at 90% also fail vs 95)
    expect(screen.getAllByText("✗").length).toBeGreaterThan(0);
    // Reason breakdown: only the two non-zero reasons render; WEATHER_ROAD is hidden.
    expect(screen.getByText("Carrier no-show")).toBeInTheDocument();
    expect(screen.getByText("No dock time available")).toBeInTheDocument();
    expect(screen.queryByText("Weather / road conditions")).not.toBeInTheDocument();
    expect(screen.getByText(/Tracked from W20/)).toBeInTheDocument();
  });
});

describe("DisruptionBreakdownChart", () => {
  test("shows an empty state at zero events", () => {
    render(
      <DisruptionBreakdownChart
        breakdown={{ reasons: [], totalCancel: 0, totalReschedule: 0, trackedFromWeekIso: null }}
      />
    );
    expect(screen.getByText(/No cancels or reschedules/i)).toBeInTheDocument();
  });
});

describe("RateVarianceHistogramChart", () => {
  test("renders red under-target bars and accent at-or-over bars", () => {
    const { container } = render(
      <RateVarianceHistogramChart
        hist={{
          bins: [
            { lo: -100, hi: 0, count: 4, underTarget: true },
            { lo: 0, hi: 100, count: 7, underTarget: false }
          ],
          median: 20,
          count: 11,
          binSize: 100
        }}
      />
    );
    const rects = [...container.querySelectorAll("rect")];
    expect(rects.some((r) => r.getAttribute("fill") === "var(--db-neg)")).toBe(true);
    expect(rects.some((r) => r.getAttribute("fill") === "var(--db-accent)")).toBe(true);
    expect(screen.getByText("$0")).toBeInTheDocument();
  });

  test("shows an empty state when there are no rated loads", () => {
    render(<RateVarianceHistogramChart hist={{ bins: [], median: null, count: 0, binSize: 100 }} />);
    expect(screen.getByText(/No rated loads/i)).toBeInTheDocument();
  });
});

describe("GrowthBars", () => {
  test("colors positive growth pos and negative growth neg", () => {
    render(<GrowthBars growth={opsFixture.growth} />);
    expect(screen.getByText("+20.0%")).toBeInTheDocument();
    expect(screen.getByText("-8.3%")).toBeInTheDocument();
  });

  test("shows 'no prior' when pct is null", () => {
    render(
      <GrowthBars
        growth={{ loadCount: { current: 5, prior: null, pct: null }, lineHaulRevenue: { current: 5, prior: null, pct: null } }}
      />
    );
    expect(screen.getAllByText("no prior").length).toBeGreaterThan(0);
  });
});
