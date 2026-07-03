import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import { DeadheadRadiusLine, DeadheadSplitChart, ShuttleLeaderboard } from "@/components/kpi/ops-charts";

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
