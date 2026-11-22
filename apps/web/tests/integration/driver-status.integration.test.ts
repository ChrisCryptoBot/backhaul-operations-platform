import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { mirrorDriverStatus } from "@/server/bridge/service";
import { memoryTransport } from "@/server/bridge/transport";

/**
 * Phase 2 step 4, the HOS read mirror, on the demo database with the in-memory bridge standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/driver-status.integration.test.ts
 * It writes to that database and puts everything back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_status";
const PHONE = "user_test_status_driver";

describe.skipIf(!run)("HOS read mirror over the bridge", () => {
  const ws = currentWorkspaceId();
  let driverId = "";
  let savedOrg: string | null = null;
  let saved: { phoneUserId: string | null; hosDriveMinutes: number | null; hosShiftMinutes: number | null; hosCycleMinutes: number | null; hosSyncedAt: Date | null } | null = null;

  beforeAll(async () => {
    savedOrg = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } })).bridgeOrgId;
    const d = await prisma.driver.findFirstOrThrow({ where: { workspaceId: ws, active: true }, orderBy: { name: "asc" }, select: { id: true, phoneUserId: true, hosDriveMinutes: true, hosShiftMinutes: true, hosCycleMinutes: true, hosSyncedAt: true } });
    driverId = d.id;
    saved = { phoneUserId: d.phoneUserId, hosDriveMinutes: d.hosDriveMinutes, hosShiftMinutes: d.hosShiftMinutes, hosCycleMinutes: d.hosCycleMinutes, hosSyncedAt: d.hosSyncedAt };
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE, hosDriveMinutes: 372, hosShiftMinutes: 500, hosCycleMinutes: 2400, hosSyncedAt: new Date("2026-11-21T20:14:00Z") } });
  });

  afterAll(async () => {
    await prisma.driver.update({ where: { id: driverId }, data: saved! });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: savedOrg } });
  });

  test("a connected driver's clocks are written once; an unchanged run writes nothing", async () => {
    const t = memoryTransport();
    const first = await mirrorDriverStatus(t, { workspaceId: ws });
    expect(first.written).toBeGreaterThanOrEqual(1);
    const mine = t.statuses.find((s) => s.driver_sub === PHONE)!;
    expect(mine).toMatchObject({ org_id: ORG, desk_driver_id: driverId, drive_minutes: 372, shift_minutes: 500, cycle_minutes: 2400, synced_at: "2026-11-21T20:14:00.000Z" });
    const writes = t.statusWrites();
    expect((await mirrorDriverStatus(t, { workspaceId: ws })).written).toBe(0);
    expect(t.statusWrites()).toBe(writes);
  });

  test("a new ELD reading is written; a driver no longer connected loses the row", async () => {
    const t = memoryTransport();
    await mirrorDriverStatus(t, { workspaceId: ws });
    await prisma.driver.update({ where: { id: driverId }, data: { hosDriveMinutes: 300, hosSyncedAt: new Date("2026-11-21T20:44:00Z") } });
    expect((await mirrorDriverStatus(t, { workspaceId: ws })).written).toBe(1);
    expect(t.statuses.find((s) => s.driver_sub === PHONE)!.drive_minutes).toBe(300);

    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: null } });
    const after = await mirrorDriverStatus(t, { workspaceId: ws });
    expect(after.removed).toBeGreaterThanOrEqual(1);
    expect(t.statuses.find((s) => s.driver_sub === PHONE)).toBeUndefined();
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE } });
  });

  test("a fleet not on the bridge writes nothing", async () => {
    const t = memoryTransport();
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: null } });
    expect(await mirrorDriverStatus(t, { workspaceId: ws })).toEqual({ written: 0, removed: 0 });
    expect(t.statuses).toHaveLength(0);
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
  });
});
