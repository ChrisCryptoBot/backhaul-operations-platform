import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { periodWindow, previousWindow, weekBuckets } from "@/lib/kpi-periods";
import { dallasDay, periodBounds, periodCovering, periodPresets } from "@/lib/settlement";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const ET = "America/New_York";
const PT = "America/Los_Angeles";

// 03:30 UTC on 1 Dec 2026 is 10:30 PM on 30 Nov in New York and 7:30 PM on 30 Nov in Los Angeles.
const NOW = Date.parse("2026-12-01T03:30:00Z");

describe("a period of money is counted on the clock given, not on whatever the browser says", () => {
  it("'this month' starts at midnight on that zone's 1st", () => {
    expect(periodWindow("month", NOW, ET).start).toBe(Date.parse("2026-11-01T04:00:00Z")); // 00:00 EDT: the clocks go back at 2 AM that morning
    expect(periodWindow("month", NOW, PT).start).toBe(Date.parse("2026-11-01T07:00:00Z")); // 00:00 PDT
  });

  it("year to date and the stretch before it use the same zone", () => {
    expect(periodWindow("ytd", NOW, ET).start).toBe(Date.parse("2026-01-01T05:00:00Z"));
    expect(previousWindow("month", NOW, ET)!.start).toBe(Date.parse("2026-10-01T04:00:00Z")); // 00:00 EDT
  });

  it("the trend's week labels are read on that zone", () => {
    expect(weekBuckets(NOW, 1, ET)[0]!.label).toBe("Nov 30");
    expect(weekBuckets(Date.parse("2026-12-01T09:30:00Z"), 1, ET)[0]!.label).toBe("Dec 1");
  });
});

describe("which statement a delivery lands on follows the workspace's zone", () => {
  it("a statement day runs from midnight to midnight on the carrier's clock", () => {
    const et = periodBounds("2026-11-02", "2026-11-08", ET)!;
    const pt = periodBounds("2026-11-02", "2026-11-08", PT)!;
    expect(et.from.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(pt.from.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(et.to.toISOString()).toBe("2026-11-09T05:00:00.000Z");
  });

  it("a Pacific delivery at 9 PM on the last day is on that week's statement for a Pacific carrier, and the next week's for an Eastern one", () => {
    const delivered = Date.parse("2026-11-09T05:00:00Z"); // 9 PM PST on 8 Nov = midnight EST on 9 Nov
    const pt = periodBounds("2026-11-02", "2026-11-08", PT)!;
    const et = periodBounds("2026-11-02", "2026-11-08", ET)!;
    expect(delivered >= pt.from.getTime() && delivered < pt.to.getTime()).toBe(true);
    expect(delivered >= et.from.getTime() && delivered < et.to.getTime()).toBe(false);
  });

  it("the day a delivery counts as, the offered presets and the period that covers a backlog all read the same zone", () => {
    const LATE = Date.parse("2026-12-01T06:30:00Z");
    expect(dallasDay(NOW, ET)).toBe("2026-11-30");
    expect(dallasDay(LATE, ET)).toBe("2026-12-01");
    expect(dallasDay(LATE, PT)).toBe("2026-11-30");
    expect(periodPresets(LATE, ET).find((p) => p.key === "month-so-far")!.start).toBe("2026-12-01");
    expect(periodPresets(LATE, PT).find((p) => p.key === "month-so-far")!.start).toBe("2026-11-01");
    expect(periodCovering([new Date(LATE)], PT)).toEqual({ start: "2026-11-30", end: "2026-11-30" });
  });
});

describe("the server asks the workspace, not the cookie, wherever money is added up", () => {
  it("the KPI, the quote report and every statement read take the workspace's stored zone", () => {
    const kpi = src("src/server/tl/kpi.ts");
    expect(kpi).toContain("const tz = await workspaceTimezone(workspaceId)");
    expect(kpi).toContain("thresholds, tz]"); // the kept answer's key carries the zone
    expect(src("src/server/tl/quote-report.ts")).toContain("await workspaceTimezone(workspaceId)");
    const s = src("src/server/tl/settlement.ts");
    // Every call to periodBounds on the server names a zone (the line that imports it is not a call).
    const calls = s.split("\n").filter((l) => l.includes("periodBounds(") && !l.startsWith("import"));
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((l) => l.includes("tz") || l.includes("workspaceTimezone"))).toBe(true);
    expect(s).toContain("periodCovering(g.loads.map((l) => l.completedAt), tz)");
    expect(src("src/app/(desk)/settlements/page.tsx")).toContain("await workspaceTimezone(currentWorkspaceId())");
  });
});
