import { describe, expect, test } from "vitest";
import { ageDays, ageText, clampPage, diffSignals, notifyDue, type DerivedSignal, type StoredSignal } from "@/lib/signals";

const d = (key: string, level: DerivedSignal["level"] = "warn"): DerivedSignal => ({ key, code: key.split(":")[1] ?? "X", level, title: "A rule", detail: "It happened", loadId: key.split(":")[0] ?? null, loadNumber: "L-1" });
const s = (key: string, over: Partial<StoredSignal> = {}): StoredSignal => ({ id: `id-${key}`, key, level: "warn", status: "open", firstSeenAt: 0, lastSeenAt: 0, resolvedAt: null, reopenCount: 0, lastLevelSent: null, ...over });

describe("how stored signals follow the derived alerts", () => {
  test("a new alert is new; one still derived is seen; one that stops being derived has resolved", () => {
    const ch = diffSignals([s("a:NO_TRUCK"), s("b:LATE")], [d("a:NO_TRUCK"), d("c:POD")]);
    expect(ch.map((c) => c.kind).sort()).toEqual(["new", "resolved", "seen"]);
    expect(ch.find((c) => c.kind === "new")).toMatchObject({ signal: { key: "c:POD" } });
    expect(ch.find((c) => c.kind === "resolved")).toEqual({ kind: "resolved", id: "id-b:LATE" });
    expect(ch.find((c) => c.kind === "seen")).toMatchObject({ id: "id-a:NO_TRUCK", levelChanged: false, escalated: false });
  });

  test("a resolved signal that comes back is reopened, not a second row", () => {
    const ch = diffSignals([s("a:NO_TRUCK", { status: "resolved", resolvedAt: 5 })], [d("a:NO_TRUCK")]);
    expect(ch).toEqual([{ kind: "reopened", id: "id-a:NO_TRUCK", signal: d("a:NO_TRUCK") }]);
  });

  test("a resolved signal that is still not derived changes nothing", () => {
    expect(diffSignals([s("a:X", { status: "resolved", resolvedAt: 5 })], [])).toEqual([]);
  });

  test("the level moving is noticed, and only a worse one is an escalation", () => {
    const up = diffSignals([s("a:X", { level: "info" })], [d("a:X", "block")])[0]!;
    expect(up).toMatchObject({ kind: "seen", levelChanged: true, escalated: true });
    const down = diffSignals([s("a:X", { level: "block" })], [d("a:X", "info")])[0]!;
    expect(down).toMatchObject({ kind: "seen", levelChanged: true, escalated: false });
  });

  test("a key derived twice is one signal, and an acknowledged one is still seen while derived", () => {
    expect(diffSignals([], [d("a:X"), d("a:X")])).toHaveLength(1);
    expect(diffSignals([s("a:X", { status: "acknowledged" })], [d("a:X")])[0]).toMatchObject({ kind: "seen" });
    // An acknowledged signal that clears resolves too.
    expect(diffSignals([s("a:X", { status: "acknowledged" })], [])[0]).toEqual({ kind: "resolved", id: "id-a:X" });
  });
});

describe("when a notification is due", () => {
  test("a block when block is asked for: once, and not again while it only repeats", () => {
    expect(notifyDue({ status: "open", level: "block", lastLevelSent: null }, "block")).toBe(true);
    expect(notifyDue({ status: "open", level: "block", lastLevelSent: "block" }, "block")).toBe(false);
  });

  test("a warn is not sent when only blocks are asked for, and is when warn or lower is asked", () => {
    expect(notifyDue({ status: "open", level: "warn", lastLevelSent: null }, "block")).toBe(false);
    expect(notifyDue({ status: "open", level: "warn", lastLevelSent: null }, "warn")).toBe(true);
    expect(notifyDue({ status: "open", level: "info", lastLevelSent: null }, "warn")).toBe(false);
    expect(notifyDue({ status: "open", level: "info", lastLevelSent: null }, "info")).toBe(true);
  });

  test("an escalation is news again; a de-escalation is not", () => {
    expect(notifyDue({ status: "open", level: "block", lastLevelSent: "warn" }, "info")).toBe(true);
    expect(notifyDue({ status: "open", level: "warn", lastLevelSent: "block" }, "info")).toBe(false);
  });

  test("an acknowledged or resolved signal is never sent", () => {
    expect(notifyDue({ status: "acknowledged", level: "block", lastLevelSent: null }, "block")).toBe(false);
    expect(notifyDue({ status: "resolved", level: "block", lastLevelSent: null }, "block")).toBe(false);
  });
});

describe("how long a signal has stayed", () => {
  const H = 3_600_000;
  test("whole days to now while open, and to the day it cleared once resolved", () => {
    expect(ageDays({ firstSeenAt: 0, resolvedAt: null }, 3 * 24 * H + 5)).toBe(3);
    expect(ageDays({ firstSeenAt: 0, resolvedAt: 2 * 24 * H }, 9 * 24 * H)).toBe(2);
    expect(ageDays({ firstSeenAt: 10, resolvedAt: null }, 5)).toBe(0);
  });

  test("in words", () => {
    expect(ageText(0, 10 * 60_000)).toBe("just now");
    expect(ageText(0, 5 * H)).toBe("5 h");
    expect(ageText(0, 47 * H)).toBe("47 h");
    expect(ageText(0, 72 * H)).toBe("3 days");
  });
});

describe("which page of signals is shown", () => {
  test("the asked page is kept inside the pages that exist", () => {
    expect(clampPage(undefined, 0, 50)).toEqual({ page: 1, pages: 1 });
    expect(clampPage(2, 120, 50)).toEqual({ page: 2, pages: 3 });
    expect(clampPage(9, 120, 50)).toEqual({ page: 3, pages: 3 });
    expect(clampPage(-4, 120, 50)).toEqual({ page: 1, pages: 3 });
    expect(clampPage(1.5, 120, 50)).toEqual({ page: 1, pages: 3 });
  });
});
