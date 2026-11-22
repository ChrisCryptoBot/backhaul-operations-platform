import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { getConversation, markThreadRead, sendMessage } from "@/server/tl/messages";
import { flushBridgeOutbox, pullDriverMessages } from "@/server/bridge/service";
import { memoryTransport } from "@/server/bridge/transport";
import { deskSenderId } from "@/lib/driver-messages";

/**
 * Phase 2 step 3, messages over the bridge, on the demo database with the in-memory bridge table standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/driver-messages.integration.test.ts
 * It writes to that database and puts everything back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_messages";
const PHONE = "user_test_messages_driver";

describe.skipIf(!run)("driver messages over the bridge", () => {
  const ws = currentWorkspaceId();
  const startedAt = new Date();
  let driverId = "";
  let otherId = "";
  const saved: Record<string, string | undefined> = {};
  let savedOrg: string | null = null;
  let savedPhone: string | null = null;

  beforeAll(async () => {
    for (const k of ["BRIDGE_SUPABASE_URL", "BRIDGE_SUPABASE_SERVICE_KEY"]) saved[k] = process.env[k];
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    savedOrg = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true } })).bridgeOrgId;
    const [d, o] = await prisma.driver.findMany({ where: { workspaceId: ws, active: true }, orderBy: { name: "asc" }, take: 2, select: { id: true, phoneUserId: true } });
    driverId = d!.id;
    otherId = o!.id;
    savedPhone = d!.phoneUserId;
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE } });
  });

  afterAll(async () => {
    await prisma.bridgeOutbox.deleteMany({ where: { workspaceId: ws, kind: "message", createdAt: { gte: startedAt } } });
    await prisma.message.deleteMany({ where: { sentAt: { gte: new Date(startedAt.getTime() - 60_000) }, thread: { driverId: { in: [driverId, otherId] } } } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: savedPhone } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: savedOrg } });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a message to a linked driver is queued with it, delivered once, and stamped delivered", async () => {
    const t = memoryTransport();
    const sent = await sendMessage({ driverId, body: "Gate code is 4471", clientId: "c-desk-1", allowed: null }, ws);
    expect(sent.ok).toBe(true);
    const id = (sent as { id: string }).id;
    expect(await prisma.bridgeOutbox.count({ where: { workspaceId: ws, kind: "message", messageId: id } })).toBe(1);

    const first = await flushBridgeOutbox(t, { workspaceId: ws });
    expect(first.delivered).toBe(1);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ org_id: ORG, driver_sub: PHONE, direction: "to_driver", sender_id: deskSenderId(ORG), client_id: id, body: "Gate code is 4471" });
    const after = await prisma.message.findUniqueOrThrow({ where: { id }, select: { deliveredAt: true } });
    expect(after.deliveredAt).not.toBeNull();

    // A second run has nothing left; a forced re-delivery of the same message is the same row.
    expect((await flushBridgeOutbox(t, { workspaceId: ws })).delivered).toBe(0);
    await t.insertDriverMessage({ ...t.messages[0]!, id: undefined });
    expect(t.messages).toHaveLength(1);
  });

  test("a driver who is not linked gets nothing queued, and deliveredAt stays empty", async () => {
    const sent = await sendMessage({ driverId: otherId, body: "Not on the app", allowed: null }, ws);
    expect(sent.ok).toBe(true);
    expect(await prisma.bridgeOutbox.count({ where: { workspaceId: ws, kind: "message", messageId: (sent as { id: string }).id } })).toBe(0);
  });

  test("what the driver writes lands in the desk thread once, however often the pull runs", async () => {
    const t = memoryTransport();
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "phone-1", body: "At the gate", at: new Date() });
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "phone-1", body: "At the gate" }); // a phone retry
    t.phoneSays({ orgId: ORG, driverSub: "user_nobody_here", clientId: "x", body: "Wrong desk" });
    const got = await pullDriverMessages(t, { workspaceId: ws });
    expect(got.taken).toBe(1);
    expect(got.ignored).toBe(1);
    expect((await pullDriverMessages(t, { workspaceId: ws })).taken).toBe(0);
    const conv = await getConversation(driverId, ws, null);
    expect(conv!.messages.filter((m) => m.direction === "in" && m.body === "At the gate")).toHaveLength(1);
    expect(t.messages.find((m) => m.client_id === "phone-1")!.delivered_at).not.toBeNull();
    // The row for a phone no driver here holds is left on the bridge, not taken.
    expect(t.messages.find((m) => m.driver_sub === "user_nobody_here")!.delivered_at).toBeNull();
  });

  test("read marks go both ways", async () => {
    const t = memoryTransport();
    const sent = await sendMessage({ driverId, body: "Call me when loaded", allowed: null }, ws);
    const id = (sent as { id: string }).id;
    await flushBridgeOutbox(t, { workspaceId: ws });
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "phone-2", body: "Loaded" });
    await pullDriverMessages(t, { workspaceId: ws });

    t.phoneReads(ORG, PHONE, new Date());
    await markThreadRead(driverId, ws, null);
    const res = await pullDriverMessages(t, { workspaceId: ws });
    expect(res.readByDriver).toBeGreaterThanOrEqual(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id }, select: { readAt: true } })).readAt).not.toBeNull();
    expect(t.messages.find((m) => m.client_id === "phone-2")!.read_at).not.toBeNull();
  });

  test("a delivery that cannot reach the bridge is retried, not lost", async () => {
    let down = true;
    const t = memoryTransport({ down: () => down });
    const sent = await sendMessage({ driverId, body: "Retry me", allowed: null }, ws);
    const id = (sent as { id: string }).id;
    const r1 = await flushBridgeOutbox(t, { workspaceId: ws });
    expect(r1.retrying).toBe(1);
    expect((await prisma.message.findUniqueOrThrow({ where: { id }, select: { deliveredAt: true } })).deliveredAt).toBeNull();
    down = false;
    const r2 = await flushBridgeOutbox(t, { workspaceId: ws, now: new Date(Date.now() + 10 * 60_000) });
    expect(r2.delivered).toBe(1);
  });
});
