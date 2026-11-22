import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DRIVER_STATUS_COLUMNS, statusPlan, toStatusRow, type DriverStatusRow } from "@/lib/driver-status";

/** Phase 2 step 4: the desk's half of the HOS read mirror, checked against the phone project's SQL so the two cannot drift. */
const PHONE_SQL = join(__dirname, "../../../../supabase/migrations/20261121000500_bridge_driver_status.sql");

const driver = (over: Partial<Parameters<typeof toStatusRow>[1]> = {}) => ({
  id: "drv_1",
  phoneUserId: "user_9",
  hosDriveMinutes: 372,
  hosShiftMinutes: 500,
  hosCycleMinutes: 2400,
  hosSyncedAt: new Date("2026-11-21T20:14:00Z"),
  unitName: "T-104",
  ...over
});

describe("HOS read mirror, desk rules", () => {
  test("a connected driver with clocks becomes one driver-safe row", () => {
    expect(toStatusRow("desk_ws1", driver())).toEqual({
      org_id: "desk_ws1",
      driver_sub: "user_9",
      desk_driver_id: "drv_1",
      drive_minutes: 372,
      shift_minutes: 500,
      cycle_minutes: 2400,
      unit_name: "T-104",
      synced_at: "2026-11-21T20:14:00.000Z"
    });
    expect(Object.keys(toStatusRow("o", driver())!).sort()).toEqual([...DRIVER_STATUS_COLUMNS].sort());
  });

  test("nothing for a driver without the app or never read from the ELD; out-of-range clocks are held to the table's limits", () => {
    expect(toStatusRow("o", driver({ phoneUserId: null }))).toBeNull();
    expect(toStatusRow("o", driver({ hosSyncedAt: null }))).toBeNull();
    const r = toStatusRow("o", driver({ hosDriveMinutes: -3, hosShiftMinutes: 99999, hosCycleMinutes: null, unitName: "x".repeat(80) }))!;
    expect([r.drive_minutes, r.shift_minutes, r.cycle_minutes, r.unit_name!.length]).toEqual([0, 1440, null, 60]);
  });

  test("only changed rows are written; phones no longer connected are removed", () => {
    const a = toStatusRow("o", driver())!;
    const b = toStatusRow("o", driver({ id: "drv_2", phoneUserId: "user_2", hosDriveMinutes: 100 }))!;
    const there: DriverStatusRow[] = [{ ...a, synced_at: "2026-11-21T20:14:00+00:00" }, { ...b, drive_minutes: 120 }, { ...a, driver_sub: "user_gone" }];
    const plan = statusPlan([a, b], there);
    expect(plan.write.map((r) => r.driver_sub)).toEqual(["user_2"]);
    expect(plan.remove).toEqual(["user_gone"]);
    expect(statusPlan([a], [])).toEqual({ write: [a], remove: [] });
  });

  test("the phone's SQL has the same columns, limits and key", () => {
    const sql = readFileSync(PHONE_SQL, "utf8");
    for (const c of DRIVER_STATUS_COLUMNS) expect(sql).toContain(c);
    expect(sql).toMatch(/primary key \(org_id, driver_sub\)/);
    expect(sql).toMatch(/drive_minutes between 0 and 1440/);
    expect(sql).toMatch(/cycle_minutes between 0 and 10080/);
    expect(sql).toMatch(/char_length\(unit_name\) <= 60/);
  });
});
