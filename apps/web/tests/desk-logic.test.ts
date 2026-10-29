import { describe, expect, test } from "vitest";
import { deriveTimeline, type TimelineLoad } from "../src/lib/desk-timeline";
import { loadWindow, windowsOverlap } from "../src/lib/schedule";
import { clearanceSoon, driverBlocker } from "../src/lib/clearance";
import { describePay, diffSnapshots, ACTION_LABEL, AUDIT_GROUPS } from "../src/lib/audit-diff";

const d = (s: string) => new Date(`2026-10-${s}:00Z`);

describe("deriveTimeline", () => {
  const base: TimelineLoad = { status: "draft", createdAt: d("20T10:00"), completedAt: null, invoicedAt: null, paidAt: null, paymentStatus: null, firstArrivedAt: null, assignment: null };
  const states = (l: TimelineLoad) => deriveTimeline(l).map((s) => s.state);

  test("a new draft: drafted is done and assigning is the next step", () => {
    expect(states(base)).toEqual(["done", "current", "pending", "pending", "pending", "pending", "pending", "pending"]);
  });

  test("assigned but not sent, then sent and waiting", () => {
    const assigned = { ...base, assignment: { status: "draft", createdAt: d("21T09:00"), dispatchedAt: null, respondedAt: null } };
    expect(states(assigned)).toEqual(["done", "done", "current", "pending", "pending", "pending", "pending", "pending"]);
    const sent = { ...base, assignment: { status: "dispatched", createdAt: d("21T09:00"), dispatchedAt: d("21T10:00"), respondedAt: null } };
    expect(states(sent)).toEqual(["done", "done", "done", "current", "pending", "pending", "pending", "pending"]);
  });

  test("a decline is a problem and nothing after it is current", () => {
    const declined = { ...base, assignment: { status: "declined", createdAt: d("21T09:00"), dispatchedAt: d("21T10:00"), respondedAt: d("21T11:00") } };
    const steps = deriveTimeline(declined);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "problem", "pending", "pending", "pending", "pending"]);
    expect(steps[3]).toMatchObject({ label: "Driver declined", note: "Assign another driver" });
  });

  test("accepted and waiting to roll, then on the road, delivered, invoiced, paid", () => {
    const acc = { ...base, status: "accepted", assignment: { status: "accepted", createdAt: d("21T09:00"), dispatchedAt: d("21T10:00"), respondedAt: d("21T11:00") } };
    expect(states(acc)).toEqual(["done", "done", "done", "done", "current", "pending", "pending", "pending"]);
    const road = { ...acc, status: "in_progress", assignment: { ...acc.assignment, status: "in_progress" }, firstArrivedAt: d("22T08:00") };
    expect(states(road)).toEqual(["done", "done", "done", "done", "done", "current", "pending", "pending"]);
    const delivered = { ...road, status: "completed", completedAt: d("23T12:00"), assignment: { ...road.assignment, status: "completed" } };
    expect(states(delivered)).toEqual(["done", "done", "done", "done", "done", "done", "current", "pending"]);
    const invoiced = { ...delivered, paymentStatus: "invoiced", invoicedAt: d("24T09:00") };
    expect(states(invoiced)).toEqual(["done", "done", "done", "done", "done", "done", "done", "current"]);
    const paid = { ...invoiced, paymentStatus: "paid", paidAt: d("30T09:00") };
    expect(states(paid).every((s) => s === "done")).toBe(true);
  });

  test("each step carries its timestamp", () => {
    const steps = deriveTimeline({ ...base, assignment: { status: "dispatched", createdAt: d("21T09:00"), dispatchedAt: d("21T10:00"), respondedAt: null } });
    expect(steps[1]!.at).toEqual(d("21T09:00"));
    expect(steps[2]!.at).toEqual(d("21T10:00"));
    expect(steps[3]!.at).toBeNull();
  });
});

describe("schedule windows", () => {
  test("a load occupies its driver from the first earliest time to the last latest time", () => {
    const w = loadWindow([
      { timeWindowEarliest: d("28T08:00"), timeWindowLatest: d("28T11:00") },
      { timeWindowEarliest: d("29T08:00"), timeWindowLatest: d("29T12:00") }
    ])!;
    expect(w.start).toEqual(d("28T08:00"));
    expect(w.end).toEqual(d("29T12:00"));
    expect(loadWindow([{ timeWindowEarliest: null, timeWindowLatest: null }])).toBeNull();
    expect(loadWindow([])).toBeNull();
  });

  test("overlap is strict: back to back does not clash", () => {
    const a = { start: d("28T08:00"), end: d("29T12:00") };
    expect(windowsOverlap(a, { start: d("29T10:00"), end: d("30T10:00") })).toBe(true);
    expect(windowsOverlap(a, { start: d("29T12:00"), end: d("30T10:00") })).toBe(false);
    expect(windowsOverlap(a, { start: d("20T08:00"), end: d("21T10:00") })).toBe(false);
    expect(windowsOverlap({ start: d("28T09:00"), end: d("28T09:00") }, a)).toBe(true);
  });
});

describe("driver clearance", () => {
  const now = d("28T12:00");
  test("blocker names the lapsed card", () => {
    expect(driverBlocker({ cdlExpiry: d("01T00:00"), medicalCardExpiry: null }, now)).toBe("CDL expired");
    expect(driverBlocker({ cdlExpiry: null, medicalCardExpiry: d("01T00:00") }, now)).toBe("Medical card expired");
    expect(driverBlocker({ cdlExpiry: null, medicalCardExpiry: null }, now)).toBeNull();
  });
  test("soon picks the earliest card inside the window and ignores lapsed ones", () => {
    const soon = clearanceSoon({ cdlExpiry: new Date(now.getTime() + 20 * 86_400_000), medicalCardExpiry: new Date(now.getTime() + 5 * 86_400_000) }, now, 30);
    expect(soon).toMatchObject({ what: "Medical card", inDays: 5 });
    expect(clearanceSoon({ cdlExpiry: new Date(now.getTime() + 90 * 86_400_000), medicalCardExpiry: null }, now, 30)).toBeNull();
    expect(clearanceSoon({ cdlExpiry: d("01T00:00"), medicalCardExpiry: null }, now, 30)).toBeNull();
  });
});

describe("audit vocabulary", () => {
  test("diff lists every field once, marks the changed ones, and shows blanks as a dash", () => {
    const rows = diffSnapshots({ Driver: "Alex Rivera", Pay: "$0.65/mi" }, { Driver: "Sam Okafor", Pay: "$0.65/mi", Note: null });
    expect(rows).toEqual([
      { field: "Driver", from: "Alex Rivera", to: "Sam Okafor", changed: true },
      { field: "Pay", from: "$0.65/mi", to: "$0.65/mi", changed: false },
      { field: "Note", from: "—", to: "—", changed: false }
    ]);
    expect(diffSnapshots(null, { Driver: "Alex" })).toEqual([{ field: "Driver", from: "—", to: "Alex", changed: true }]);
  });
  test("pay reads the way a dispatcher says it", () => {
    expect(describePay("cpm", 0.65)).toBe("$0.65/mi");
    expect(describePay("flat", 450)).toBe("Flat $450.00");
    expect(describePay("hourly", 28)).toBe("$28.00/hr");
  });
  test("every action in a filter group has a label", () => {
    for (const g of AUDIT_GROUPS) for (const a of g.actions) expect(ACTION_LABEL[a]).toBeTruthy();
  });
});
