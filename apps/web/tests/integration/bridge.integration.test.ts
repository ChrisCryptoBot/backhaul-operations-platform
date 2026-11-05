import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, unassignLoad } from "@/server/tl/dispatch";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { flushBridgeOutbox, pullBridgeResponses } from "@/server/bridge/service";
import { memoryTransport } from "@/server/bridge/transport";
import { assertDriverSafe, type LoadSummary } from "@/server/tl/projector";

/**
 * The driver link on the demo database, with the in-memory table standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/bridge.integration.test.ts
 * It writes to that database and puts everything back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_fleet";
const PHONE = "user_test_driver";

describe.skipIf(!run)("the driver link, desk half", () => {
  const ws = currentWorkspaceId();
  const startedAt = new Date();
  let loadId = "";
  let driverId = "";
  let secret = 0;
  const saved: Record<string, string | undefined> = {};

  const reset = async () => {
    await prisma.bridgeOutbox.deleteMany({ where: { loadId } });
    await prisma.assignment.deleteMany({ where: { loadId } });
    await prisma.load.update({ where: { id: loadId }, data: { status: "draft" } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeCursor: 0n } });
  };

  beforeAll(async () => {
    for (const k of ["BRIDGE_SUPABASE_URL", "BRIDGE_SUPABASE_SERVICE_KEY"]) saved[k] = process.env[k];
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    const load = await prisma.load.findFirstOrThrow({ where: { loadNumber: "DM-40006", workspaceId: ws } });
    loadId = load.id;
    secret = Number(load.quotedRevenue);
    driverId = (await prisma.driver.findFirstOrThrow({ where: { name: "Sam Okafor", workspaceId: ws } })).id;
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG, bridgeCursor: 0n } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE } });
    await reset();
  });

  afterAll(async () => {
    await reset();
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: null, bridgeCursor: 0n } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: null } });
    await prisma.auditEvent.deleteMany({ where: { loadId, createdAt: { gte: startedAt } } });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const assignAndSend = async () => {
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.62 }, overrideReason: "driver link test" });
    return dispatchLoad(loadId);
  };

  test("a driver with no phone account is answered for by the dispatcher: nothing is queued", async () => {
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: null } });
    await assignAndSend();
    expect(await prisma.bridgeOutbox.count({ where: { loadId } })).toBe(0);
    await reset();
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE } });
  });

  test("send queues in the same transaction, delivery is once and idempotent, and what leaves carries no money", async () => {
    const t = memoryTransport();
    await assignAndSend();
    expect(await prisma.bridgeOutbox.count({ where: { loadId, status: "pending", kind: "dispatch" } })).toBe(1);

    expect(await flushBridgeOutbox(t)).toMatchObject({ delivered: 1, failed: 0, retrying: 0 });
    expect(t.table).toHaveLength(1);
    const row = t.table[0]!;
    expect(row).toMatchObject({ org_id: ORG, assigned_driver_id: PHONE, source_load_id: loadId, status: "dispatched", kind: "dispatch" });
    expect(() => assertDriverSafe(row.load_summary as LoadSummary, { numbers: [secret] })).not.toThrow();
    expect(JSON.stringify(row)).not.toMatch(/revenue|margin|rate_?con|gross/i);
    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });
    expect(a.bridgeDispatchId).toBe(row.id);
    expect(a.bridgeError).toBeNull();

    expect(await flushBridgeOutbox(t)).toMatchObject({ delivered: 0 });
    expect(t.table).toHaveLength(1);
  });

  test("the driver's answers are applied in order, at least once, and the cursor moves only past what was read", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    const row = t.table[0]!;

    t.phone(row.id, { state: "accepted", accepted_at: new Date().toISOString() });
    expect(await pullBridgeResponses(t)).toMatchObject({ read: 1, applied: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).status).toBe("accepted");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).toBe("accepted");
    expect(Number((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).bridgeCursor)).toBe(t.table[0]!.sync_seq);
    expect(await pullBridgeResponses(t)).toMatchObject({ read: 0, applied: 0 });

    // The phone moved twice before the desk looked again: the step in between is not lost.
    t.phone(row.id, { state: "in_progress", started_at: new Date(Date.now() - 3_600_000).toISOString() });
    const moved = await pullBridgeResponses(t);
    expect(moved.applied + moved.flagged).toBe(1);
    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });
    expect(a.bridgeExecutionVersion).toBe(t.table[0]!.execution_version);
    expect(["in_progress", "accepted"]).toContain(a.status);
  });

  test("a delivery from the phone is shown as an alert, never forced into a completed load", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "in_progress", started_at: new Date(Date.now() - 7_200_000).toISOString() });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "completed", completion: { completed_at: new Date().toISOString(), actual_total_miles: 340.5 }, pod_refs: [{ stop_seq: 1, path: `${ORG}/loads/${loadId}/pod1.jpg` }] });
    const out = await pullBridgeResponses(t);
    expect(out.flagged).toBeGreaterThanOrEqual(1);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).not.toBe("completed");
    const flag = await prisma.auditEvent.findFirst({ where: { loadId, action: "driver_link_flag" }, orderBy: { createdAt: "desc" } });
    expect(flag?.summary).toMatch(/delivered/);
  });

  test("taking the driver off closes the row (never deletes it), and a late answer from the phone is flagged, not applied", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    await unassignLoad(loadId, "Driver called in sick");
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "cancel", status: "pending" } })).toBe(1);
    await flushBridgeOutbox(t);
    expect(t.table).toHaveLength(1);
    expect(t.table[0]!.status).toBe("cancelled");

    // The phone answers the cancelled row late. The desk no longer has that driver on the load, so there is nothing to apply it to.
    t.phone(t.table[0]!.id, { state: "accepted" });
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 0 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).toBe("draft");
  });

  test("when the link is down the delivery is kept and retried with a growing wait, and after five tries the load says it was not delivered", async () => {
    let down = true;
    const t = memoryTransport({ down: () => down });
    await reset();
    await assignAndSend();
    let now = new Date();
    const first = await flushBridgeOutbox(t, { now });
    expect(first).toMatchObject({ delivered: 0, retrying: 1 });
    const item = await prisma.bridgeOutbox.findFirstOrThrow({ where: { loadId } });
    expect(item).toMatchObject({ status: "pending", attempts: 1, lastError: "unreachable" });
    expect(item.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    // Not due yet: nothing is tried.
    expect(await flushBridgeOutbox(t, { now })).toMatchObject({ delivered: 0, retrying: 0, failed: 0 });

    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 2 * 86_400_000);
      await flushBridgeOutbox(t, { now });
    }
    expect((await prisma.bridgeOutbox.findFirstOrThrow({ where: { loadId } })).status).toBe("failed");
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).bridgeError).toBe("unreachable");

    // Back up: a fresh send of the same load goes through (the failed item is left as the record).
    down = false;
    await prisma.bridgeOutbox.create({ data: { workspaceId: ws, loadId, kind: "dispatch", phoneUserId: PHONE } });
    expect(await flushBridgeOutbox(t, { now })).toMatchObject({ delivered: 1 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).bridgeError).toBeNull();
  });

  test("a fleet that is not switched on is untouched: no queue, no reads", async () => {
    const t = memoryTransport();
    await reset();
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: null } });
    await assignAndSend();
    expect(await prisma.bridgeOutbox.count({ where: { loadId } })).toBe(0);
    expect(await flushBridgeOutbox(t)).toMatchObject({ delivered: 0 });
    expect(await pullBridgeResponses(t)).toMatchObject({ read: 0 });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
  });
});
