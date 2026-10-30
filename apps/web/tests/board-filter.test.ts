import { describe, expect, test } from "vitest";
import { BOARD_STATUSES, filterBoard, onTab } from "@/lib/board-filter";

const row = (status: string, assignmentStatus: string | null, loadNumber = "L") => ({ status, assignmentStatus, verdict: null, loadNumber, brokerName: null, origin: null, destination: null, vehicleName: null, driverName: null });

describe("the Loads board's tabs", () => {
  test("Needs a driver is a load with no driver, a chosen driver not yet sent, or one who said no; a sent load is Sent, waiting", () => {
    expect(BOARD_STATUSES.map((s) => s.key)).toEqual(["all", "draft", "sent", "accepted", "in_progress", "completed"]);
    for (const a of [null, "draft", "declined"]) expect(onTab(row("draft", a), "draft"), String(a)).toBe(true);
    expect(onTab(row("draft", "dispatched"), "draft")).toBe(false);
    expect(onTab(row("draft", "dispatched"), "sent")).toBe(true);
    expect(onTab(row("draft", null), "sent")).toBe(false);
  });

  test("the other tabs go by the load's status, and All is everything", () => {
    expect(onTab(row("accepted", "accepted"), "accepted")).toBe(true);
    expect(onTab(row("in_progress", "in_progress"), "in_progress")).toBe(true);
    expect(onTab(row("accepted", "accepted"), "draft")).toBe(false);
    expect(onTab(row("completed", "completed"), "all")).toBe(true);
  });

  test("the screen and the file filter the same way, with the text search on top", () => {
    const rows = [row("draft", null, "A"), row("draft", "dispatched", "B"), row("accepted", "accepted", "C")];
    expect(filterBoard(rows, { status: "draft" }).map((r) => r.loadNumber)).toEqual(["A"]);
    expect(filterBoard(rows, { status: "sent" }).map((r) => r.loadNumber)).toEqual(["B"]);
    expect(filterBoard(rows, { status: "all", q: "c" }).map((r) => r.loadNumber)).toEqual(["C"]);
  });
});
