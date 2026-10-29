import { describe, expect, test } from "vitest";
import { buildPlanner, buildWatchlist, planDays, spanText, type PlannerLoad, type PlannerStop } from "../src/lib/planner";

const H = 3_600_000;
const utc = (s: string) => Date.parse(s);
const NOW = utc("2026-10-28T17:00:00Z"); // noon Central, Wednesday 28 Oct 2026

const stop = (sequence: number, role: string, startH: number, endH: number, over: Partial<PlannerStop> = {}): PlannerStop => ({
  sequence,
  type: role,
  role,
  facility: `${role} dock`,
  city: role === "pickup" ? "Dallas" : "Atlanta",
  earliest: new Date(NOW + startH * H),
  latest: new Date(NOW + endH * H),
  arrivedAt: null,
  ...over
});

function load(id: string, over: Partial<PlannerLoad> = {}, stops?: PlannerStop[]): PlannerLoad {
  return {
    id,
    loadNumber: `DM-${id}`,
    origin: "Dallas, TX",
    destination: "Atlanta, GA",
    status: "accepted",
    driverId: "d1",
    driverName: "Alex Rivera",
    assignmentStatus: "accepted",
    stops: stops ?? [stop(1, "pickup", 2, 5), stop(2, "delivery", 26, 30)],
    ...over
  };
}

describe("planner days", () => {
  test("seven Central days from the day an instant falls in, with today marked and each ending a millisecond before the next", () => {
    const days = planDays(NOW, 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ key: "2026-10-28", weekday: "Wed", label: "Oct 28", isToday: true });
    expect(days[1]).toMatchObject({ key: "2026-10-29", weekday: "Thu", isToday: false });
    expect(days[0]!.start).toBe(utc("2026-10-28T05:00:00Z"));
    for (let i = 1; i < 7; i++) expect(days[i]!.start).toBe(days[i - 1]!.end + 1);
  });

  test("across the clocks going back on 1 Nov the day after is still the next calendar day, 25 hours long", () => {
    const days = planDays(utc("2026-10-31T17:00:00Z"), 3, NOW);
    expect(days.map((d) => d.key)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(days[1]!.end - days[1]!.start + 1).toBe(25 * H);
  });
});

describe("the planner grid", () => {
  const days = planDays(NOW, 4, NOW);
  const drivers = [
    { id: "d1", name: "Alex Rivera" },
    { id: "d2", name: "Sam Okafor" }
  ];

  test("a load shows on every day it runs, once per day, in the driver's row", () => {
    const { rows } = buildPlanner([load("1")], drivers, days);
    const alex = rows.find((r) => r.driverId === "d1")!;
    expect(alex.cells.map((c) => c.length)).toEqual([1, 1, 0, 0]); // picks up today, delivers tomorrow
    expect(alex.cells[0]![0]).toMatchObject({ loadId: "1", lane: "Dallas → Atlanta", startsHere: true, endsHere: false });
    expect(alex.cells[1]![0]).toMatchObject({ startsHere: false, endsHere: true });
    expect(rows.find((r) => r.driverId === "d2")!.cells.every((c) => c.length === 0)).toBe(true);
  });

  test("a load still on the road stays in its driver's row after its delivery window closed on an earlier day", () => {
    const late = load("11", { status: "in_progress", assignmentStatus: "in_progress" }, [stop(1, "pickup", -30, -27), stop(2, "delivery", -26, -24)]); // the window closed yesterday noon
    const without = buildPlanner([late], drivers, days).rows[0]!;
    expect(without.cells.flat()).toHaveLength(0); // by its windows alone it ended before the first day
    const withNow = buildPlanner([late], drivers, days, NOW).rows[0]!;
    expect(withNow.cells[0]!.map((i) => i.loadId)).toEqual(["11"]); // but it has not been delivered, so it is still there today
    expect(withNow.cells[1]!).toHaveLength(0); // and no further than now
    // A load that is not on the road is not stretched: a missed pickup is the alerts' job.
    const missed = load("12", { status: "accepted" }, [stop(1, "pickup", -30, -27), stop(2, "delivery", -26, -24)]);
    expect(buildPlanner([missed], drivers, days, NOW).rows[0]!.cells.flat()).toHaveLength(0);
  });

  test("a load with no driver, or whose driver declined, waits in the tray, and a cancelled one is not shown", () => {
    const { rows, tray } = buildPlanner([load("2", { driverId: null, driverName: null, assignmentStatus: null, status: "draft" }), load("3", { assignmentStatus: "declined", status: "draft" }), load("4", { status: "cancelled" })], drivers, days);
    expect(tray[0]!.map((i) => i.loadId).sort()).toEqual(["2", "3"]);
    expect(rows.every((r) => r.cells.every((c) => c.length === 0))).toBe(true);
  });

  test("two open loads for one driver that overlap are both marked as a conflict; back to back is not", () => {
    const a = load("5", {}, [stop(1, "pickup", 2, 5), stop(2, "delivery", 20, 24)]);
    const overlap = load("6", {}, [stop(1, "pickup", 10, 12), stop(2, "delivery", 30, 34)]);
    const after = load("7", {}, [stop(1, "pickup", 24, 26), stop(2, "delivery", 40, 44)]);
    const flagged = buildPlanner([a, overlap], drivers, days).rows[0]!;
    expect(flagged.cells[0]!.map((i) => i.conflict)).toEqual([true, true]);
    const fine = buildPlanner([a, after], drivers, days).rows[0]!;
    expect(fine.cells.flat().every((i) => !i.conflict)).toBe(true);
    const otherDriver = buildPlanner([a, load("8", { driverId: "d2", driverName: "Sam Okafor" }, [stop(1, "pickup", 10, 12), stop(2, "delivery", 30, 34)])], drivers, days);
    expect(otherDriver.rows.flatMap((r) => r.cells.flat()).every((i) => !i.conflict)).toBe(true);
  });

  test("a delivered load is shown but never counts as a conflict, and a draft assigned but unsent says so", () => {
    const done = load("9", { status: "completed", assignmentStatus: "completed" }, [stop(1, "pickup", 2, 5), stop(2, "delivery", 6, 8)]);
    const open = load("10", { status: "draft", assignmentStatus: "draft" }, [stop(1, "pickup", 3, 4), stop(2, "delivery", 7, 9)]);
    const cell = buildPlanner([done, open], drivers, days).rows[0]!.cells[0]!;
    expect(cell.find((i) => i.loadId === "9")).toMatchObject({ done: true, conflict: false });
    expect(cell.find((i) => i.loadId === "10")).toMatchObject({ notSent: true, conflict: false });
  });

  test("a driver who holds a load but is not in the list still gets a row", () => {
    const { rows } = buildPlanner([load("11", { driverId: "gone", driverName: "Casey Brooks" })], drivers, days);
    expect(rows.map((r) => r.name)).toEqual(["Alex Rivera", "Sam Okafor", "Casey Brooks"]);
  });

  test("a load with no times at all cannot be placed and is left off", () => {
    const { rows, tray } = buildPlanner([load("12", {}, [{ ...stop(1, "pickup", 0, 0), earliest: null, latest: null }])], drivers, days);
    expect(rows.flatMap((r) => r.cells.flat())).toHaveLength(0);
    expect(tray.flat()).toHaveLength(0);
  });
});

describe("the due-now watchlist", () => {
  test("past due first, then today, then tomorrow, then what was reached today", () => {
    const loads = [
      load("a", {}, [stop(1, "pickup", -30, -27, { arrivedAt: new Date(NOW - 26 * H) }), stop(2, "delivery", -3, -1)]), // delivery window closed 1 h ago, nobody there
      load("b", {}, [stop(1, "pickup", -20, -17, { arrivedAt: new Date(NOW - 20 * H) }), stop(2, "delivery", 2, 5)]), // due today
      load("c", {}, [stop(1, "pickup", -10, -7, { arrivedAt: new Date(NOW - 9.5 * H) }), stop(2, "delivery", 14, 18)]), // due tomorrow (Central)
      load("d", {}, [stop(1, "pickup", -4, -2, { arrivedAt: new Date(NOW - 1.5 * H) }), stop(2, "delivery", 60, 64)]) // reached its pickup late today
    ];
    const w = buildWatchlist(loads, NOW);
    // c's pickup was reached at 7:30 this morning, so it is in the "reached today" group too; within a group the earlier window is first
    expect(w.map((x) => `${x.loadNumber}:${x.stopRole}:${x.state}`)).toEqual(["DM-a:delivery:past_due", "DM-b:delivery:today", "DM-c:delivery:upcoming", "DM-c:pickup:done", "DM-d:pickup:done"]);
    expect(w[0]!.minutesOver).toBe(60);
  });

  test("arrival against the window: on time, or late by minutes, only for stops reached today", () => {
    const onTime = load("e", { status: "in_progress" }, [stop(1, "pickup", -4, -2, { arrivedAt: new Date(NOW - 2.5 * H) }), stop(2, "delivery", 70, 74)]);
    const late = load("f", { status: "in_progress" }, [stop(1, "pickup", -4, -2, { arrivedAt: new Date(NOW - 1.25 * H) }), stop(2, "delivery", 70, 74)]);
    const yesterday = load("g", { status: "in_progress" }, [stop(1, "pickup", -30, -28, { arrivedAt: new Date(NOW - 29 * H) }), stop(2, "delivery", 70, 74)]);
    const w = buildWatchlist([onTime, late, yesterday], NOW);
    expect(w.map((x) => x.loadNumber)).toEqual(["DM-e", "DM-f"]); // g's pickup was yesterday, and its delivery is days away
    expect(w.find((x) => x.loadNumber === "DM-e")).toMatchObject({ state: "done", late: false, minutesLate: null });
    expect(w.find((x) => x.loadNumber === "DM-f")).toMatchObject({ state: "done", late: true, minutesLate: 45 });
  });

  test("an unassigned draft whose pickup has gone is past due too: the stop needs chasing whoever has it", () => {
    const w = buildWatchlist([load("h", { status: "draft", driverId: null, driverName: null, assignmentStatus: null }, [stop(1, "pickup", -5, -2), stop(2, "delivery", 20, 24)])], NOW);
    expect(w[0]).toMatchObject({ state: "past_due", driverName: null });
  });

  test("a delivered load with no recorded arrival is not chased, and a cancelled one is ignored", () => {
    const w = buildWatchlist([load("i", { status: "completed" }, [stop(1, "pickup", -40, -38), stop(2, "delivery", -20, -18)]), load("j", { status: "cancelled" }, [stop(1, "pickup", -5, -2)])], NOW);
    expect(w).toEqual([]);
  });

  test("how long is how long", () => {
    expect([35, 60, 130, 0].map(spanText)).toEqual(["35 min", "1 h", "2 h 10 min", "0 min"]);
  });
});
