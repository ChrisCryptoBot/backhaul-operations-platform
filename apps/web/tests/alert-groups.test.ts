import { describe, expect, test } from "vitest";
import { clashOf, groupAlerts } from "@/lib/alert-groups";
import type { Alert, AlertCode, AlertLevel } from "@/lib/alerts";

const a = (n: number, code: string, level: AlertLevel, message: string): Alert => ({ key: `l${n}:${code}`, code: code as AlertCode, level, loadId: `l${n}`, loadNumber: `DM-${n}`, message });
const truck = (n: number, others: string) => a(n, "TRUCK_DOUBLE_BOOKED", "block", `Unit 101 is also on ${others} at the same time.`);

describe("the alerts as a to-do list", () => {
  test("the same problem on several loads is one line with its loads", () => {
    const g = groupAlerts([1, 2, 3].map((n) => a(n, "PICKUP_NO_DRIVER", "block", "The pickup time has passed and no driver has been sent.")));
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ level: "block", title: "The pickup time has passed and no driver has been sent." });
    expect(g[0]!.loads.map((l) => [l.loadNumber, l.detail])).toEqual([["DM-1", null], ["DM-2", null], ["DM-3", null]]);
  });

  test("one rule worded differently on each load is one line by the rule's name, and each load keeps its own words", () => {
    const g = groupAlerts([a(1, "LATE_ON_ROAD", "warn", "The delivery window closed 9 d ago and the load is not delivered."), a(2, "LATE_ON_ROAD", "warn", "The delivery window closed 3 h ago and the load is not delivered.")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.title).not.toContain("9 d");
    expect(g[0]!.loads[1]!.detail).toContain("3 h ago");
  });

  test("a truck on three overlapping loads is one line, not three", () => {
    const g = groupAlerts([truck(2, "DM-8, DM-11"), truck(8, "DM-2, DM-11"), truck(11, "DM-2, DM-8")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.title).toBe("Unit 101 is on 3 overlapping loads");
    expect(g[0]!.loads.map((l) => l.loadNumber)).toEqual(["DM-11", "DM-2", "DM-8"]);
  });

  test("two separate clashes stay two, and two people with one name are not joined", () => {
    const d = (n: number, other: string) => a(n, "DOUBLE_BOOKED", "block", `Sam Lee is also booked on ${other} at the same time.`);
    expect(groupAlerts([d(1, "DM-2"), d(2, "DM-1"), d(5, "DM-6"), d(6, "DM-5")])).toHaveLength(2);
    expect(groupAlerts([d(1, "DM-2"), d(2, "DM-1"), truck(3, "DM-4"), truck(4, "DM-3")])).toHaveLength(2);
  });

  test("every alert is in exactly one group at its own level, worst first; a message it cannot read stands on its own", () => {
    const all = [truck(2, "DM-8"), truck(8, "DM-2"), a(1, "PICKUP_NO_DRIVER", "block", "x"), a(3, "MISSING_POD", "warn", "y"), a(4, "MISSING_POD", "info", "z"), a(9, "DOUBLE_BOOKED", "block", "worded another way")];
    const g = groupAlerts(all);
    expect(g.flatMap((x) => x.loads.map((l) => l.key)).sort()).toEqual(all.map((x) => x.key).sort());
    const rank = { block: 0, warn: 1, info: 2 } as const;
    expect(g.map((x) => rank[x.level])).toEqual([...g.map((x) => rank[x.level])].sort());
    expect(g.find((x) => x.loads[0]!.loadNumber === "DM-9")!.title).toBe("worded another way");
    expect(clashOf("worded another way")).toBeNull();
  });
});
