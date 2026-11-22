import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { getConversation, markThreadRead, sendMessage } from "@/server/tl/messages";
import { flushBridgeOutbox, pullDriverMessages, purgeDriverMessages } from "@/server/bridge/service";
import { BridgeTransportError, memoryTransport } from "@/server/bridge/transport";
import { removeFiles } from "@/server/tl/message-files";
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
    // The photos this file fetched into desk storage go with their messages.
    const kept = await prisma.messageAttachment.findMany({ where: { message: { sentAt: { gte: new Date(startedAt.getTime() - 3 * 86_400_000) }, thread: { driverId: { in: [driverId, otherId] } } } }, select: { storageKey: true } });
    await removeFiles(kept.map((k) => k.storageKey));
    await prisma.bridgeOutbox.deleteMany({ where: { workspaceId: ws, kind: "message", createdAt: { gte: startedAt } } });
    await prisma.message.deleteMany({ where: { sentAt: { gte: new Date(startedAt.getTime() - 3 * 86_400_000) }, thread: { driverId: { in: [driverId, otherId] } } } });
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

  // A JPEG the desk's checks accept (start, APP0, DQT, scan, end).
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
  const folder = `org/${ORG}/driver/${PHONE}/`;

  test("a driver's photo is fetched into the desk's storage, checked, and attached to the message", async () => {
    const t = memoryTransport();
    t.files.set(`${folder}p-photo-1-0.jpg`, JPEG);
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-photo-1", body: "BOL signed", attachments: [{ path: `${folder}p-photo-1-0.jpg`, mime: "image/jpeg" }] });
    const got = await pullDriverMessages(t, { workspaceId: ws });
    expect(got).toMatchObject({ taken: 1, files: 1, waiting: 0 });
    const conv = await getConversation(driverId, ws, null);
    const m = conv!.messages.find((x) => x.direction === "in" && x.body === "BOL signed")!;
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ kind: "image", mime: "image/jpeg", name: "p-photo-1-0.jpg" });
    // A second pull keeps one copy and fetches nothing again.
    expect((await pullDriverMessages(t, { workspaceId: ws })).files).toBe(0);
  });

  test("a photo the link no longer has, one the checks refuse, or one outside the driver's folder is named in the text, not kept", async () => {
    const t = memoryTransport();
    t.files.set(`${folder}p-photo-2-1.jpg`, new TextEncoder().encode("not a picture"));
    t.files.set(`org/${ORG}/driver/someone_else/x.jpg`, JPEG);
    t.phoneSays({
      orgId: ORG,
      driverSub: PHONE,
      clientId: "p-photo-2",
      body: "Seal",
      attachments: [{ path: `${folder}p-photo-2-0.jpg` }, { path: `${folder}p-photo-2-1.jpg` }, { path: `org/${ORG}/driver/someone_else/x.jpg` }]
    });
    const got = await pullDriverMessages(t, { workspaceId: ws });
    expect(got).toMatchObject({ taken: 1, files: 0 });
    const conv = await getConversation(driverId, ws, null);
    const m = conv!.messages.find((x) => x.direction === "in" && x.body.startsWith("Seal"))!;
    expect(m.attachments).toHaveLength(0);
    expect(m.body).toBe("Seal\n(2 files from the phone not kept: the desk's file checks refused it)\n(1 file from the phone not kept: it was no longer on the phone link)");
  });

  test("a link that cannot hand over a photo leaves the message on the bridge; the next run takes it with the photo", async () => {
    const t = memoryTransport();
    t.files.set(`${folder}p-photo-3-0.jpg`, JPEG);
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-photo-3", body: "Lumper receipt", attachments: [{ path: `${folder}p-photo-3-0.jpg` }] });
    const real = t.downloadDriverFile.bind(t);
    t.downloadDriverFile = async () => {
      throw new BridgeTransportError("unreachable", "The driver link could not be reached.");
    };
    const first = await pullDriverMessages(t, { workspaceId: ws });
    expect(first).toMatchObject({ taken: 0, waiting: 1 });
    expect(t.messages.find((x) => x.client_id === "p-photo-3")!.delivered_at).toBeNull();
    t.downloadDriverFile = real;
    expect(await pullDriverMessages(t, { workspaceId: ws })).toMatchObject({ taken: 1, files: 1 });
  });

  test("retention: a message read more than a day ago leaves the bridge with its photo; newer, unread or untaken ones stay; the desk keeps its copy", async () => {
    const t = memoryTransport();
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 86_400_000);
    t.files.set(`${folder}p-old-0.jpg`, JPEG);
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-old", body: "Old one", attachments: [{ path: `${folder}p-old-0.jpg` }], at: old });
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-new", body: "New one", at: now });
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-unread", body: "Nobody read me", at: old });
    await pullDriverMessages(t, { workspaceId: ws });
    for (const m of t.messages) {
      if (m.client_id === "p-old") m.read_at = new Date(now.getTime() - 25 * 3_600_000).toISOString();
      if (m.client_id === "p-new") m.read_at = new Date(now.getTime() - 3_600_000).toISOString();
    }
    // A row the desk has not taken is never purged, however old its read mark.
    t.messages.push({ ...t.messages[0]!, id: "msg-untaken", client_id: "p-untaken", delivered_at: null, read_at: old.toISOString() });

    const res = await purgeDriverMessages(t, { workspaceId: ws, now });
    expect(res).toEqual({ removed: 1, files: 1 });
    expect(t.messages.map((m) => m.client_id).sort()).toEqual(["p-new", "p-unread", "p-untaken"]);
    expect(t.files.has(`${folder}p-old-0.jpg`)).toBe(false);
    const conv = await getConversation(driverId, ws, null);
    const kept = conv!.messages.find((x) => x.body === "Old one")!;
    expect(kept.attachments).toHaveLength(1);
    expect((await purgeDriverMessages(t, { workspaceId: ws, now })).removed).toBe(0);
  });

  test("retention: when the files cannot be removed, the rows stay for the next run", async () => {
    const t = memoryTransport();
    const now = new Date();
    t.files.set(`${folder}p-stuck-0.jpg`, JPEG);
    t.phoneSays({ orgId: ORG, driverSub: PHONE, clientId: "p-stuck", body: "Stuck", attachments: [{ path: `${folder}p-stuck-0.jpg` }], at: new Date(now.getTime() - 3 * 86_400_000) });
    await pullDriverMessages(t, { workspaceId: ws });
    t.messages[0]!.read_at = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    t.removeDriverFiles = async () => {
      throw new BridgeTransportError("unreachable", "The driver link could not be reached.");
    };
    await expect(purgeDriverMessages(t, { workspaceId: ws, now })).rejects.toThrow();
    expect(t.messages).toHaveLength(1);
  });

  test("the conversation says whether messages reach this driver's phone", async () => {
    expect((await getConversation(driverId, ws, null))!.bridged).toBe(true);
    expect((await getConversation(otherId, ws, null))!.bridged).toBe(false);
  });
});
