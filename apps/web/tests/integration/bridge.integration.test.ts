import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, driverSummaryFor, unassignLoad } from "@/server/tl/dispatch";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { flushBridgeOutbox, pullBridgeResponses } from "@/server/bridge/service";
import { memoryTransport } from "@/server/bridge/transport";
import { clearAlertCache, getAlerts } from "@/server/tl/alerts";
import { ANSWERS_EVERY_MS, pullAnswersNow, __resetLivePullForTest } from "@/server/bridge/live";
import { pullStopEvents } from "@/server/bridge/stops";
import { assertDriverSafe, type LoadSummary } from "@/server/tl/projector";
import { completeTrip, startTrip } from "@/server/tl/execution";
import { deleteLoad } from "@/server/tl/remove";
import { toCentralLocal } from "@/lib/zoned";

/**
 * The driver link on the demo database, with the in-memory table standing in for Supabase (no network):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/bridge.integration.test.ts
 * It writes to that database and puts everything back, so it is skipped unless RUN_DB_INTEGRATION=true.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const ORG = "org_test_fleet";
const PHONE = "user_test_driver";
const PHONE_2 = "user_test_driver_2";

describe.skipIf(!run)("the driver link, desk half", () => {
  const ws = currentWorkspaceId();
  const startedAt = new Date();
  let loadId = "";
  let driverId = "";
  let secret = 0;
  const saved: Record<string, string | undefined> = {};
  // What the demo desk was linked to before this ran: put back after, so a run never unlinks it.
  let link: { bridgeOrgId: string | null; bridgeCursor: bigint; bridgeStopCursor: bigint } = { bridgeOrgId: null, bridgeCursor: 0n, bridgeStopCursor: 0n };
  let savedPhone: string | null = null;

  const reset = async () => {
    await prisma.bridgeOutbox.deleteMany({ where: { loadId } });
    await prisma.loadDocument.deleteMany({ where: { loadId, addedBy: "Driver's phone" } });
    await prisma.checkCall.deleteMany({ where: { loadId, loggedBy: "Driver's phone" } });
    await prisma.stop.updateMany({ where: { loadId }, data: { arrivedAt: null, waitMinutes: null, sealNumber: null, arrivedSource: null } });
    await prisma.assignment.deleteMany({ where: { loadId } });
    await prisma.load.update({ where: { id: loadId }, data: { status: "draft", deletedAt: null } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeCursor: 0n, bridgeStopCursor: 0n } });
  };

  beforeAll(async () => {
    for (const k of ["BRIDGE_SUPABASE_URL", "BRIDGE_SUPABASE_SERVICE_KEY"]) saved[k] = process.env[k];
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    const load = await prisma.load.findFirstOrThrow({ where: { loadNumber: "DM-40006", workspaceId: ws } });
    loadId = load.id;
    secret = Number(load.quotedRevenue);
    const sam = await prisma.driver.findFirstOrThrow({ where: { name: "Sam Okafor", workspaceId: ws } });
    driverId = sam.id;
    savedPhone = sam.phoneUserId;
    link = await prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { bridgeOrgId: true, bridgeCursor: true, bridgeStopCursor: true } });
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeOrgId: ORG, bridgeCursor: 0n } });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: PHONE } });
    await reset();
  });

  afterAll(async () => {
    await reset();
    await prisma.workspace.update({ where: { id: ws }, data: link });
    await prisma.driver.update({ where: { id: driverId }, data: { phoneUserId: savedPhone } });
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
    // Nobody signed in (a test): no sender name is kept or sent.
    expect(a.dispatchedBy).toBeNull();
    expect(row.load_summary).not.toHaveProperty("dispatcher");

    expect(await flushBridgeOutbox(t)).toMatchObject({ delivered: 0 });
    expect(t.table).toHaveLength(1);
  });

  test("a pay change after sending takes the phone's offer back and needs its own reason; no change at all is nothing to do", async () => {
    await reset();
    const t = memoryTransport();
    await assignAndSend();
    await flushBridgeOutbox(t);
    const sent = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });

    // The same driver at the same pay: nothing moves, nothing is told to the phone.
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.62 } });
    const same = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });
    expect(same).toMatchObject({ status: "dispatched", assignmentVersion: sent.assignmentVersion });
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "reassign_old" } })).toBe(0);

    // A new pay needs a reason of its own: the old catch-all reason does not cover it.
    const refused = await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.7 }, overrideReason: "driver link test" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DispatchError);
    expect((refused as DispatchError).code).toBe("reasons_needed");
    expect((refused as DispatchError).needs.map((n) => n.code)).toEqual(["pay_changed"]);

    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.7 }, reasons: { pay_changed: "Customer raised the rate", double_booked: "driver link test" } });
    expect(await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).toMatchObject({ status: "draft" });
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "reassign_old", status: "pending" } })).toBe(1);
    await flushBridgeOutbox(t);
    expect(t.table[0]).toMatchObject({ status: "reassigned" });
    // The driver accepts the withdrawn offer anyway: it does not land, and the desk says so loudly instead of only in the audit log.
    t.phone(t.table[0]!.id, { state: "accepted" });
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 0, flagged: 1 });
    clearAlertCache();
    const flagged = (await getAlerts(new Date(), ws, "open")).alerts.filter((x) => x.loadId === loadId && x.code === "DRIVER_LINK_FLAG");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.level).toBe("block");
    await dispatchLoad(loadId);
    // Sending it again is acting on the assignment: the warning has been answered.
    clearAlertCache();
    expect((await getAlerts(new Date(), ws, "open")).alerts.some((x) => x.loadId === loadId && x.code === "DRIVER_LINK_FLAG")).toBe(false);
    await flushBridgeOutbox(t);
    const open = t.table.filter((r) => r.status === "dispatched");
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(t.table[0]!.id);
    const audit = await prisma.auditEvent.findFirst({ where: { loadId, action: "reassigned" }, orderBy: { createdAt: "desc" } });
    // Sam is also on another demo load at that time: each reason is kept beside its own condition.
    expect(audit?.reason).toBe("Double-booked: driver link test; Pay changed after sending: Customer raised the rate");
  });

  test("an assignment someone else changed since the window opened is refused, not written over", async () => {
    await reset();
    const dbl = { double_booked: "driver link test" }; // Sam is also on another demo load at that time
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.62 }, reasons: dbl });
    const stale = await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.65 }, reasons: dbl, expected: { assignmentVersion: null, driverId: null } }).catch((e: unknown) => e);
    expect((stale as DispatchError).code).toBe("stale");
    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId } });
    expect(Number(a.payRate)).toBe(0.62);
    // The version the window saw is accepted.
    await assignDriver({ loadId, driverId, pay: { kind: "cpm", rate: 0.65 }, reasons: dbl, expected: { assignmentVersion: a.assignmentVersion, driverId } });
    expect(Number((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).payRate)).toBe(0.65);
  });

  test("the queue's live look applies a driver's answer at once, and only once per window however many tabs ask", async () => {
    await reset();
    __resetLivePullForTest();
    const t = memoryTransport();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    const now = new Date();
    expect(await pullAnswersNow(t, { now })).toEqual({ pulled: true, changed: true });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).status).toBe("accepted");
    // A second tab ten seconds later does not hit the link again.
    expect(await pullAnswersNow(t, { now: new Date(now.getTime() + 10_000) })).toEqual({ pulled: false, changed: false });
    // After the window, a look with nothing new says so.
    expect(await pullAnswersNow(t, { now: new Date(now.getTime() + ANSWERS_EVERY_MS + 1) })).toEqual({ pulled: true, changed: false });
  });

  test("who sent it goes by name only", async () => {
    await reset();
    await assignAndSend();
    await prisma.assignment.update({ where: { loadId }, data: { dispatchedBy: "Maria Lopez" } });
    const t = memoryTransport();
    await flushBridgeOutbox(t);
    const summary = t.table[0]!.load_summary as LoadSummary;
    expect(summary.dispatcher).toEqual({ name: "Maria Lopez" });
    expect(() => assertDriverSafe(summary, { numbers: [secret] })).not.toThrow();
    // A name that is really an email is not sent.
    await prisma.assignment.update({ where: { loadId }, data: { dispatchedBy: "maria@northline.example" } });
    expect(await driverSummaryFor(loadId, ws)).not.toHaveProperty("dispatcher");
    await reset();
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

  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
  const podPath = (dispatchId: string, seq: number) => `org/${ORG}/driver/${PHONE}/pod-${dispatchId}-${seq}.jpg`;
  const onTheRoad = async (t: ReturnType<typeof memoryTransport>) => {
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "in_progress", started_at: new Date(Date.now() - 7_200_000).toISOString() });
    await pullBridgeResponses(t);
  };

  test("a delivery from the phone is applied (G10, Step 2): the delivery time, the miles by leg, and the proof photo filed on its stop", async () => {
    const t = memoryTransport();
    await onTheRoad(t);
    const row = t.table[0]!;
    t.files.set(podPath(row.id, 2), JPEG);
    t.phone(row.id, { state: "completed", completion: { completed_at: new Date().toISOString(), actual_total_miles: 340.5, miles: { pickup: 20, loaded: 300.5, home: 20 } }, pod_refs: [{ stop_seq: 2, path: podPath(row.id, 2) }] });
    const out = await pullBridgeResponses(t);
    expect(out).toMatchObject({ applied: 1, flagged: 0, filed: 1 });
    const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(load.status).toBe("completed");
    expect(load.closedWithoutPod).toBe(false);
    expect(load.podNote).toContain("1 proof of delivery photo");
    expect(load.podNote).toContain("340.5 mi driven");
    expect([Number(load.pickupDeadheadMiles), Number(load.loadedMiles), Number(load.returnDeadheadMiles)]).toEqual([20, 300.5, 20]);
    const docs = await prisma.loadDocument.findMany({ where: { loadId, addedBy: "Driver's phone" } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: "pod", addedBy: "Driver's phone", stopId: load.stops[1]!.id });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).status).toBe("completed");
    // At least once: reading the same row again changes nothing, and files nothing twice.
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 0 });
    expect(await prisma.loadDocument.count({ where: { loadId, addedBy: "Driver's phone" } })).toBe(1);
    const audit = await prisma.auditEvent.findFirst({ where: { loadId, action: "delivered", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toContain("from the driver's phone");
  });

  test("a delivery whose photos cannot be fetched waits (the cursor stays before it), then lands with them", async () => {
    let down = false;
    const t = memoryTransport({ down: () => down });
    await onTheRoad(t);
    const row = t.table[0]!;
    t.files.set(podPath(row.id, 2), JPEG);
    t.phone(row.id, { state: "completed", completion: { completed_at: new Date().toISOString() }, pod_refs: [{ stop_seq: 2, path: podPath(row.id, 2) }] });
    const cursorBefore = Number((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).bridgeCursor);
    // The bucket does not answer, but the table does: only the file fetch fails.
    const realDownload = t.downloadDriverFile;
    t.downloadDriverFile = async (p) => {
      down = true;
      try {
        return await realDownload(p);
      } finally {
        down = false;
      }
    };
    expect(await pullBridgeResponses(t)).toMatchObject({ waiting: 1, applied: 0 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).toBe("in_progress");
    expect(Number((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).bridgeCursor)).toBe(cursorBefore);
    t.downloadDriverFile = realDownload;
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 1, filed: 1 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).toBe("completed");
  });

  test("stop events from the phone (Step 2): the real arrival replaces the start time, the wait and seal land, a check call is logged once", async () => {
    const t = memoryTransport();
    await onTheRoad(t);
    const row = t.table[0]!;
    const stopsOf = () => prisma.stop.findMany({ where: { loadId }, orderBy: { stopSequence: "asc" } });
    // The phone's start stood in for the pickup arrival.
    expect((await stopsOf())[0]).toMatchObject({ arrivedSource: "phone" });
    const arrived = new Date(Date.now() - 5_400_000);
    t.phoneStop({ dispatchId: row.id, driverSub: PHONE, kind: "arrived", stopSeq: 1, at: arrived });
    t.phoneStop({ dispatchId: row.id, driverSub: PHONE, kind: "loaded", stopSeq: 1, at: new Date(Date.now() - 2_700_000), waitMinutes: 45, seal: "S-4471" });
    t.phoneStop({ dispatchId: row.id, driverSub: PHONE, kind: "check_call", at: new Date(Date.now() - 600_000), lat: 35.222, lng: -101.831 });
    expect(await pullStopEvents(t)).toMatchObject({ read: 3, applied: 2, checkCalls: 1, flagged: 0 });
    const [pickup] = await stopsOf();
    expect(pickup).toMatchObject({ arrivedAt: arrived, waitMinutes: 45, sealNumber: "S-4471", arrivedSource: "phone" });
    const calls = await prisma.checkCall.findMany({ where: { loadId, loggedBy: "Driver's phone" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.place).toContain("Amarillo, TX");
    // Read again from the start: nothing changes and the check call is not logged twice.
    await prisma.workspace.update({ where: { id: ws }, data: { bridgeStopCursor: 0n } });
    await pullStopEvents(t);
    expect(await prisma.checkCall.count({ where: { loadId, loggedBy: "Driver's phone" } })).toBe(1);
    const audit = await prisma.auditEvent.findFirst({ where: { loadId, action: "stop_event", createdAt: { gte: startedAt } }, orderBy: { createdAt: "asc" } });
    expect(audit?.summary).toMatch(/^Arrived at stop 1 .*, from the driver's phone$/);
  });

  test("a stop time the dispatcher entered is never overwritten by the phone: a different one is flagged; another phone's events are ignored", async () => {
    const t = memoryTransport();
    await onTheRoad(t);
    const row = t.table[0]!;
    const deskTime = new Date(Date.now() - 6_000_000);
    const [, delivery] = await prisma.stop.findMany({ where: { loadId }, orderBy: { stopSequence: "asc" } });
    await prisma.stop.update({ where: { id: delivery!.id }, data: { arrivedAt: deskTime, arrivedSource: "desk" } });
    t.phoneStop({ dispatchId: row.id, driverSub: PHONE, kind: "arrived", stopSeq: 2, at: new Date(Date.now() - 600_000) });
    expect(await pullStopEvents(t)).toMatchObject({ applied: 0, flagged: 1 });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: delivery!.id } })).arrivedAt).toEqual(deskTime);
    const flag = await prisma.auditEvent.findFirst({ where: { loadId, action: "driver_link_flag", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(flag?.summary).toContain("The desk's entry was kept");
    // An event written for this load by a phone that does not hold it on the desk.
    t.stopEvents.push({ ...t.stopEvents[0]!, id: "forged", driver_sub: "user_someone_else", sync_seq: 10_000 });
    expect(await pullStopEvents(t)).toMatchObject({ ignored: 1, applied: 0 });
  });

  test("a proof path outside this driver's folder is never fetched: the delivery is recorded without it, and flagged", async () => {
    const t = memoryTransport();
    await onTheRoad(t);
    const row = t.table[0]!;
    const theirs = `org/${ORG}/driver/someone_else/pod-${row.id}-2.jpg`;
    t.files.set(theirs, JPEG);
    t.phone(row.id, { state: "completed", completion: { completed_at: new Date().toISOString() }, pod_refs: [{ stop_seq: 2, path: theirs }] });
    expect(await pullBridgeResponses(t)).toMatchObject({ flagged: 1, filed: 0 });
    const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    expect([load.status, load.closedWithoutPod]).toEqual(["completed", true]);
    expect(await prisma.loadDocument.count({ where: { loadId, addedBy: "Driver's phone" } })).toBe(0);
  });

  test("an accept taken back on the phone (accepted in error) is applied before the pickup: the load is back on the board", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "declined", reason: "Accepted in error", declined_reason: "Accepted in error" });
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 1, flagged: 0 });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId } })).status).toBe("declined");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).status).toBe("draft");
    const audit = await prisma.auditEvent.findFirst({ where: { loadId, action: "declined", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toContain("took back their accept on their phone");
  });

  test("a pickup and delivery from the phone are audited as from the driver's phone, and queue nothing back to it", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "in_progress", started_at: new Date(Date.now() - 7_200_000).toISOString() });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "completed", completion: { completed_at: new Date().toISOString() } });
    await pullBridgeResponses(t);
    const audits = await prisma.auditEvent.findMany({ where: { loadId, action: { in: ["trip_started", "delivered"] }, createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" }, take: 2 });
    expect(audits.map((a) => a.summary).join(" | ")).toMatch(/from the driver's phone[\s\S]*from the driver's phone/);
    expect(audits.some((a) => a.summary.includes("entered by the desk"))).toBe(false);
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "update" } })).toBe(0);
  });

  test("a pickup and delivery the desk entered reach the driver's phone (an update each), even once delivered", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    expect(await startTrip(loadId, { arrivedAt: toCentralLocal(Date.now() - 7_200_000), waitMinutes: "", seal: "" })).toEqual({ ok: true });
    expect(await completeTrip(loadId, { stops: [], deliveredAt: toCentralLocal(Date.now() - 60_000), pod: "none", podNote: "Not sent in this test", fuel: "", tolls: "", misc: "" })).toEqual({ ok: true });
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "update", status: "pending" } })).toBe(2);
    const seqBefore = t.table[0]!.sync_seq;
    expect(await flushBridgeOutbox(t)).toMatchObject({ delivered: 2, failed: 0 });
    expect(t.table[0]!.sync_seq).toBeGreaterThan(seqBefore);
    expect(t.table[0]!.driver_response).toMatchObject({ state: "accepted" }); // an update never clears the driver's answer
  });

  test("deleting a load that is on the driver's phone takes it off the phone (the row is closed as cancelled)", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    expect(await deleteLoad({ loadId, reason: "mistake" })).toEqual({ ok: true });
    expect(await prisma.bridgeOutbox.count({ where: { loadId, kind: "cancel", status: "pending" } })).toBe(1);
    await flushBridgeOutbox(t);
    expect(t.table[0]!.status).toBe("cancelled");
  });

  test("a proof path outside the fleet's or the driver's folder is dropped: the delivery is recorded with no proof, and says so", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    t.phone(t.table[0]!.id, { state: "accepted" });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "in_progress", started_at: new Date(Date.now() - 7_200_000).toISOString() });
    await pullBridgeResponses(t);
    t.phone(t.table[0]!.id, { state: "completed", completion: { completed_at: new Date().toISOString() }, pod_refs: [{ path: "../other_fleet/pod.jpg" }] });
    expect(await pullBridgeResponses(t)).toMatchObject({ applied: 1 });
    const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
    expect(load.closedWithoutPod).toBe(true);
    expect(load.podNote).toMatch(/filed no proof of delivery/);
  });

  test("two runs at once never deliver the same row twice (G10 lease, FOR UPDATE SKIP LOCKED)", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    const now = new Date();
    const [a, b] = await Promise.all([flushBridgeOutbox(t, { now }), flushBridgeOutbox(t, { now })]);
    expect(a.delivered + b.delivered).toBe(1);
    expect(t.table).toHaveLength(1);
    const item = await prisma.bridgeOutbox.findFirstOrThrow({ where: { loadId } });
    expect(item).toMatchObject({ status: "done", leaseUntil: null });
  });

  test("a row whose lease is still held by another run is left alone until the lease runs out", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    const now = new Date();
    await prisma.bridgeOutbox.updateMany({ where: { loadId }, data: { leaseUntil: new Date(now.getTime() + 60_000) } });
    expect(await flushBridgeOutbox(t, { now })).toMatchObject({ delivered: 0 });
    expect(await flushBridgeOutbox(t, { now: new Date(now.getTime() + 120_000) })).toMatchObject({ delivered: 1 });
  });

  test("a reassigned row says which row replaced it (G10 replaced_by_dispatch_id)", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    const first = t.table[0]!;
    const other = await prisma.driver.findFirstOrThrow({ where: { workspaceId: ws, active: true, id: { not: driverId } }, select: { id: true, phoneUserId: true } });
    await prisma.driver.update({ where: { id: other.id }, data: { phoneUserId: PHONE_2 } });
    try {
      await assignDriver({ loadId, driverId: other.id, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "driver link test" });
      await dispatchLoad(loadId);
      await flushBridgeOutbox(t);
      const closed = t.table.find((r) => r.id === first.id)!;
      const fresh = t.table.find((r) => r.assigned_driver_id === PHONE_2)!;
      expect(closed.status).toBe("reassigned");
      expect(fresh).toBeTruthy();
      expect(closed.replaced_by_dispatch_id).toBe(fresh.id);
    } finally {
      await prisma.driver.update({ where: { id: other.id }, data: { phoneUserId: other.phoneUserId } });
    }
  });

  test("taking the driver off closes the row (never deletes it), and a late answer from the phone is flagged, not applied", async () => {
    const t = memoryTransport();
    await reset();
    await assignAndSend();
    await flushBridgeOutbox(t);
    await unassignLoad(loadId, "Driver called in sick", undefined, undefined, undefined, "HOS_TIMEOUT");
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
