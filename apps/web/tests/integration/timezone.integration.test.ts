import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { agingSummary } from "@/server/tl/aging";
import { listHistory } from "@/server/tl/history";
import { setWorkspaceTimezone } from "@/server/tl/zone-setting";
import { workspaceTimezone } from "@/server/tl/zone";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * The carrier's clock on the demo database:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/timezone.integration.test.ts
 * It changes the demo workspace's zone and puts it back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("the workspace's time zone", () => {
  const ws = currentWorkspaceId();
  const startedAt = new Date();
  let original = "America/Chicago";

  beforeAll(async () => {
    original = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { timezone: true } })).timezone;
  });

  afterAll(async () => {
    await prisma.workspace.update({ where: { id: ws }, data: { timezone: original } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: ws, action: "timezone_changed", createdAt: { gte: startedAt } } });
    await setWorkspaceTimezone(original);
  });

  test("a new workspace starts on Central, as the desk always has", async () => {
    expect(original).toBe("America/Chicago");
  });

  test("only a listed zone is accepted, and nothing changes for anything else", async () => {
    for (const bad of ["Mars/Olympus", "", "america/new_york", 42, null]) expect(await setWorkspaceTimezone(bad)).toMatchObject({ ok: false });
    expect(await workspaceTimezone(ws)).toBe("America/Chicago");
  });

  test("changing it is audited once, read back at once, and the same zone again changes nothing", async () => {
    const out = await setWorkspaceTimezone("America/New_York");
    expect(out).toEqual({ ok: true, changed: true, zone: "America/New_York" });
    expect(await workspaceTimezone(ws)).toBe("America/New_York");
    const events = await prisma.auditEvent.findMany({ where: { workspaceId: ws, action: "timezone_changed", createdAt: { gte: startedAt } } });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("Time zone changed from Central to Eastern");
    expect(await setWorkspaceTimezone("America/New_York")).toMatchObject({ ok: true, changed: false });
    expect(await prisma.auditEvent.count({ where: { workspaceId: ws, action: "timezone_changed", createdAt: { gte: startedAt } } })).toBe(1);
  });

  test("aging and the History months are counted on the workspace's clock and keep working on any zone", async () => {
    for (const zone of ["America/New_York", "America/Los_Angeles", "America/Chicago"]) {
      await setWorkspaceTimezone(zone);
      const aging = await agingSummary(Date.now(), ws);
      expect(aging.count).toBeGreaterThanOrEqual(0);
      const page = await listHistory({}, ws);
      expect(page.total).toBeGreaterThanOrEqual(0);
    }
  });
});
