import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { DispatchError, assignDriver, dispatchLoad, findTruckClash, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { RelayError, acknowledgeDiscrepancy, flagDiscrepancy, handoffsOfLoad, legsOfLoad, openHandoffs, receiveHandoff, recordDrop } from "@/server/tl/relay";
import { completeTrip, reopenDelivered, saveExpenses, startTrip, undoStartTrip } from "@/server/tl/execution";
import { eligibleLoads, finalizeSettlement, settlementsOfLoad, startSettlement, unsettledByDriver, voidSettlement } from "@/server/tl/settlement";
import { saveLoadDetails } from "@/server/tl/edit";
import { deleteLoad } from "@/server/tl/remove";
import { listBoardRows } from "@/server/tl/queries";
import { filterBoard } from "@/lib/board-filter";
import { toEditValues } from "@/lib/load-edit";
import { toCentralLocal } from "@/lib/zoned";
import { holderTrail } from "@/server/tl/assignment-events";
import { listLoadAudit } from "@/server/tl/audit";
import { cancelLoad, recordTonu } from "@/server/tl/disruptions";
import { getAlerts, clearAlertCache } from "@/server/tl/alerts";

/**
 * Relays on a database of its own workspace (docs/RELAY_DESIGN.md, phase 2): drop, receive, discrepancy, the empty recall, and what each leaves behind.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/tl-relay.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "rl-w";
const H = 3_600_000;
const D = 86_400_000;
const NOW = new Date();
const GOOD = { type: "drop_hook", reason: "planned", locationName: "Albuquerque yard", slot: "12", outgoingNext: "bobtail", sealNumber: "48291", milesDriven: 412, milesSource: "eld" } as const;
const PAY = { kind: "cpm", rate: 0.62 } as const;

describe.skipIf(!run)("relays: a baton between two drivers", () => {
  const ids = { d1: "", d2: "", d3: "", t1: "", t2: "", trailer: "" };
  const loadIds: string[] = [];
  let n = 0;

  /** A load on the road with driver 1 in truck 1 pulling the trailer. */
  async function rolling(label: string, over: { vehicleId?: string; trailerId?: string | null } = {}) {
    const start = NOW.getTime() - 6 * H + n++ * 0;
    const load = await prisma.load.create({
      data: {
        workspaceId: W, loadNumber: label, status: "in_progress", vehicleId: over.vehicleId ?? ids.t1, trailerId: over.trailerId === undefined ? ids.trailer : over.trailerId, quotedRevenue: 2400, loadedMiles: 1200,
        stops: { create: [
          { stopSequence: 1, stopType: "pickup", addressString: "Phoenix, AZ", timeWindowEarliest: new Date(start - H), timeWindowLatest: new Date(start), arrivedAt: new Date(start) },
          { stopSequence: 2, stopType: "delivery", addressString: "Dallas, TX", timeWindowEarliest: new Date(NOW.getTime() + 20 * H), timeWindowLatest: new Date(NOW.getTime() + 24 * H) }
        ] }
      }
    });
    loadIds.push(load.id);
    await prisma.assignment.create({ data: { loadId: load.id, driverId: ids.d1, payKind: "cpm", payRate: 0.6, payEstimate: 720, status: "in_progress", respondedAt: NOW } });
    return load;
  }
  const hookTrailer = (vehicleId: string) => prisma.trailer.update({ where: { id: ids.trailer }, data: { currentVehicleId: vehicleId, hookedAt: new Date(NOW.getTime() - 8 * H), unhookedAt: null, dwellWaived: false } });
  let seq = 0;
  const fresh = async () => ({ driver: await driver(`RL Next ${++seq}`), truck: (await prisma.vehicle.create({ data: { workspaceId: W, name: `RL Next Truck ${seq}` } })).id });
  const driver = (name: string) => prisma.driver.create({ data: { workspaceId: W, name, cdlExpiry: new Date(NOW.getTime() + 400 * D), medicalCardExpiry: new Date(NOW.getTime() + 400 * D), defaultPayKind: "cpm", defaultPayRate: 0.55 } }).then((d) => d.id);

  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Relay test fleet", plan: "enterprise" } });
    ids.d1 = await driver("RL Driver One");
    ids.d2 = await driver("RL Driver Two");
    ids.d3 = await driver("RL Driver Three");
    ids.t1 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "RL Truck 1" } })).id;
    ids.t2 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "RL Truck 2" } })).id;
    ids.trailer = (await prisma.trailer.create({ data: { workspaceId: W, number: "RL-501" } })).id;
  });
  afterAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } }); // loads, legs, handoffs, assignments and events go with it
  });

  test("a drop closes leg 1, takes the assignment off, unhooks the trailer without a dwell leak, and waits in the yard", async () => {
    const load = await rolling("RL-1");
    await hookTrailer(ids.t1);
    const h = await recordDrop(load.id, GOOD, NOW, W, null);
    expect(h).toMatchObject({ state: "dropped", type: "drop_hook", outLegSeq: 1, outDriverName: "RL Driver One", tractorOutName: "RL Truck 1", trailerNumber: "RL-501", droppedSource: "dispatcher", sealNumber: "48291" });

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { assignment: true } });
    expect([after.status, after.assignment]).toEqual(["in_progress", null]); // on the road, nobody holding it

    const [leg1] = await legsOfLoad(load.id, W);
    expect(leg1).toMatchObject({ seq: 1, kind: "haul", status: "closed", driverName: "RL Driver One", vehicleName: "RL Truck 1", milesSource: "eld", payKind: "cpm" });
    expect(Number(leg1!.milesDriven)).toBe(412);
    expect(Number(leg1!.payRate)).toBe(0.6);
    expect(Number(leg1!.payEstimate)).toBe(247.2); // Phase 3: 412 mi * $0.60/mi

    const tr = await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } });
    expect(tr.currentVehicleId).toBeNull();
    expect(tr.dwellWaived).toBe(true);
    expect(tr.dwellOverrideNote).toContain("Relay handoff");
    expect((await prisma.trailerMove.findMany({ where: { trailerId: ids.trailer, kind: "dropped" } })).length).toBeGreaterThan(0);

    expect((await holderTrail(load.id, W)).map((e) => e.kind)).toEqual(["dropped"]);
    expect((await listLoadAudit(load.id, 25, W)).map((e) => e.action)).toContain("handoff_dropped");
    expect((await openHandoffs(W, null, NOW)).find((o) => o.loadId === load.id)?.badge).toBe("Relay · leg 1 of 2 · awaiting handoff at Albuquerque yard");
  });

  test("the next driver's tap takes custody: leg 2, the new truck, the trailer hooked with its dwell clock reset, a frozen hash, and no pay estimate yet", async () => {
    const load = await rolling("RL-2");
    const nx = await fresh();
    await hookTrailer(ids.t1);
    const h = await recordDrop(load.id, GOOD, NOW, W, null);
    const got = await receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY, sealMatches: true, conditionOk: true }, new Date(NOW.getTime() + 90 * 60_000), W, null);
    expect(got).toMatchObject({ state: "received", inLegSeq: 2, receivedSource: "dispatcher", sealMatches: true });
    expect(got.inDriverName).toMatch(/^RL Next/);
    expect(got.frozenSha256).toMatch(/^[0-9a-f]{64}$/);

    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId: load.id } });
    expect([a.driverId, a.status, a.payEstimate]).toEqual([nx.driver, "in_progress", null]);
    const l = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect([l.status, l.vehicleId]).toEqual(["in_progress", nx.truck]);

    const legs = await legsOfLoad(load.id, W);
    expect(legs.map((x) => [x.seq, x.status, x.fromName])).toEqual([[1, "closed", "Phoenix, AZ"], [2, "active", "Albuquerque yard"]]);
    expect(legs[0]!.driverName).toBe("RL Driver One");
    expect(legs[1]!.payKind).toBe("cpm");
    expect(Number(legs[1]!.payRate)).toBe(0.62);

    const tr = await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } });
    expect([tr.currentVehicleId, tr.dwellWaived, tr.unhookedAt]).toEqual([nx.truck, false, null]);

    expect((await holderTrail(load.id, W)).map((e) => e.kind)).toEqual(["dropped", "received"]);
    expect((await listLoadAudit(load.id, 25, W)).map((e) => e.action)).toEqual(expect.arrayContaining(["handoff_dropped", "handoff_received"]));
    expect((await openHandoffs(W, null, NOW)).some((o) => o.loadId === load.id)).toBe(false);
  });

  test("bridged drivers' phones are told: the drop closes the outgoing driver's row, the receive sends the load to the incoming driver", async () => {
    const saved = { url: process.env.BRIDGE_SUPABASE_URL, key: process.env.BRIDGE_SUPABASE_SERVICE_KEY };
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    try {
      await prisma.workspace.update({ where: { id: W }, data: { bridgeOrgId: "org_rl_test" } });
      const load = await rolling("RL-BRIDGE");
      const nx = await fresh();
      await prisma.driver.update({ where: { id: ids.d1 }, data: { phoneUserId: "user_rl_out" } });
      await prisma.driver.update({ where: { id: nx.driver }, data: { phoneUserId: "user_rl_in" } });
      await hookTrailer(ids.t1);
      const h = await recordDrop(load.id, GOOD, NOW, W, null);
      expect(await prisma.bridgeOutbox.findMany({ where: { loadId: load.id }, select: { kind: true, phoneUserId: true } })).toEqual([{ kind: "cancel", phoneUserId: "user_rl_out" }]);
      await receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY }, new Date(NOW.getTime() + 90 * 60_000), W, null);
      const queued = await prisma.bridgeOutbox.findMany({ where: { loadId: load.id }, orderBy: { createdAt: "asc" }, select: { kind: true, phoneUserId: true } });
      expect(queued).toEqual([{ kind: "cancel", phoneUserId: "user_rl_out" }, { kind: "dispatch", phoneUserId: "user_rl_in" }]);
    } finally {
      await prisma.driver.updateMany({ where: { workspaceId: W }, data: { phoneUserId: null } });
      await prisma.workspace.update({ where: { id: W }, data: { bridgeOrgId: null } });
      process.env.BRIDGE_SUPABASE_URL = saved.url;
      process.env.BRIDGE_SUPABASE_SERVICE_KEY = saved.key;
      if (saved.url === undefined) delete process.env.BRIDGE_SUPABASE_URL;
      if (saved.key === undefined) delete process.env.BRIDGE_SUPABASE_SERVICE_KEY;
    }
  });

  test("a driver swap keeps the truck and the trailer where they are, and refuses a different truck", async () => {
    const load = await rolling("RL-3");
    const nx = await fresh();
    await hookTrailer(ids.t1);
    const h = await recordDrop(load.id, { ...GOOD, type: "slip_seat", reason: "hos", outgoingNext: "available_at_yard" }, NOW, W, null);
    expect((await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } })).currentVehicleId).toBe(ids.t1); // not unhooked
    await expect(receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY }, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
    await receiveHandoff(h.id, { driverId: nx.driver, pay: PAY }, NOW, W, null);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).vehicleId).toBe(ids.t1);
    expect((await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } })).currentVehicleId).toBe(ids.t1);
  });

  test("a breakdown rescue is a different truck and driver; it moves the load and hooks the trailer to the rescue truck", async () => {
    const load = await rolling("RL-4");
    const nx = await fresh();
    await hookTrailer(ids.t1);
    const h = await recordDrop(load.id, { ...GOOD, type: "rescue", reason: "breakdown", locationName: null, lat: 35.2, lng: -111.6, locationSetBy: "emergency_pin", outgoingNext: "bobtail" }, NOW, W, null);
    expect(h).toMatchObject({ locationSetBy: "emergency_pin", reason: "breakdown" });
    await expect(receiveHandoff(h.id, { driverId: nx.driver, vehicleId: ids.t1, pay: PAY }, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
    await receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY }, NOW, W, null);
    expect((await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } })).currentVehicleId).toBe(nx.truck);
  });

  test("what cannot be dropped: a load not on the road, an incomplete drop, a second drop", async () => {
    const accepted = await rolling("RL-5");
    await prisma.load.update({ where: { id: accepted.id }, data: { status: "accepted" } });
    await prisma.assignment.update({ where: { loadId: accepted.id }, data: { status: "accepted" } });
    await expect(recordDrop(accepted.id, GOOD, NOW, W, null)).rejects.toMatchObject({ code: "not_relayable" });

    const load = await rolling("RL-6");
    await expect(recordDrop(load.id, { ...GOOD, outgoingNext: undefined }, NOW, W, null)).rejects.toMatchObject({ code: "bad_handoff" });
    await expect(recordDrop(load.id, { ...GOOD, locationName: "" }, NOW, W, null)).rejects.toMatchObject({ code: "bad_handoff" });
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(1); // nothing was taken off
    await recordDrop(load.id, GOOD, NOW, W, null);
    await expect(recordDrop(load.id, GOOD, NOW, W, null)).rejects.toBeInstanceOf(RelayError);
    expect((await handoffsOfLoad(load.id, W)).length).toBe(1);
  });

  test("the baton is taken once: two receives at once land one, and the same driver cannot take it back", async () => {
    const load = await rolling("RL-7");
    const a = await fresh();
    const b = await fresh();
    const h = await recordDrop(load.id, GOOD, NOW, W, null);
    await expect(receiveHandoff(h.id, { driverId: ids.d1, vehicleId: a.truck, pay: PAY }, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
    const out = await Promise.allSettled([
      receiveHandoff(h.id, { driverId: a.driver, vehicleId: a.truck, pay: PAY }, NOW, W, null),
      receiveHandoff(h.id, { driverId: b.driver, vehicleId: b.truck, pay: PAY }, NOW, W, null)
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(1);
    expect((await legsOfLoad(load.id, W)).length).toBe(2);
  });

  test("a driver already on another load at that time needs a reason; with one, it is kept", async () => {
    const other = await rolling("RL-8A");
    await prisma.assignment.update({ where: { loadId: other.id }, data: { driverId: ids.d3 } });
    const load = await rolling("RL-8B");
    const nx = await fresh();
    const h = await recordDrop(load.id, GOOD, NOW, W, null);
    await expect(receiveHandoff(h.id, { driverId: ids.d3, vehicleId: nx.truck, pay: PAY }, NOW, W, null)).rejects.toMatchObject({ code: "double_booked" });
    await receiveHandoff(h.id, { driverId: ids.d3, vehicleId: nx.truck, pay: PAY, overrideReason: "Covering a sick driver" }, NOW, W, null);
    expect((await holderTrail(load.id, W)).at(-1)).toMatchObject({ kind: "received", reasonNote: "Covering a sick driver" });
  });

  test("a discrepancy freezes the baton and blocks custody until dispatch acknowledges it; then the driver can take it, with the discrepancy on record", async () => {
    const load = await rolling("RL-9");
    const nx = await fresh();
    const h = await recordDrop(load.id, GOOD, NOW, W, null);
    await expect(flagDiscrepancy(h.id, { notes: "x", raisedBy: "incoming_driver" }, NOW, W, null)).rejects.toMatchObject({ code: "bad_discrepancy" });
    const flagged = await flagDiscrepancy(h.id, { notes: "Bolt seal broken, tire slashed", raisedBy: "incoming_driver" }, NOW, W, null);
    expect(flagged).toMatchObject({ state: "disputed", discrepancyFlagged: true, discrepancyBy: "Incoming driver" });
    expect(flagged.frozenSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(flagDiscrepancy(h.id, { notes: "again", raisedBy: "dispatcher" }, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
    await expect(receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY }, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
    const acked = await acknowledgeDiscrepancy(h.id, NOW, W, null);
    expect(acked).toMatchObject({ state: "dropped", discrepancyFlagged: true });
    expect(acked.ackAt).not.toBeNull();
    const got = await receiveHandoff(h.id, { driverId: nx.driver, vehicleId: nx.truck, pay: PAY, sealMatches: false, conditionOk: false, conditionNotes: "tire" }, NOW, W, null);
    expect(got).toMatchObject({ state: "received", discrepancyFlagged: true, sealMatches: false, conditionOk: false });
    expect(got.conditionNotes).toContain("Found on pickup: tire");
    await expect(acknowledgeDiscrepancy(h.id, NOW, W, null)).rejects.toMatchObject({ code: "not_receivable" });
  });

  test("a load waiting in the yard can be cancelled: the baton goes with it and nothing throws", async () => {
    const load = await rolling("RL-10");
    await recordDrop(load.id, GOOD, NOW, W, null);
    await cancelLoad({ loadId: load.id, reason: "broker_cancelled" } as never, NOW, W);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("cancelled");
  });

  test("another workspace's load is 'not found'; a limited person cannot hand off a load outside their terminals", async () => {
    const load = await rolling("RL-11");
    await expect(recordDrop(load.id, GOOD, NOW, "some-other-workspace", null)).rejects.toMatchObject({ code: "load_not_found" });
    await prisma.vehicle.update({ where: { id: ids.t1 }, data: { terminal: "Dallas" } });
    await expect(recordDrop(load.id, GOOD, NOW, W, ["Memphis"] as never)).rejects.toMatchObject({ code: "load_not_found" });
    await prisma.vehicle.update({ where: { id: ids.t1 }, data: { terminal: null } });
  });

  test("a load dropped by a hook has left its truck, so the truck is free for another load; a driver swap keeps it", async () => {
    const hook = await prisma.vehicle.create({ data: { workspaceId: W, name: "RL Hook Truck" } });
    const swap = await prisma.vehicle.create({ data: { workspaceId: W, name: "RL Swap Truck" } });
    const a = await rolling("RL-13A", { vehicleId: hook.id, trailerId: null });
    const b = await rolling("RL-13B", { vehicleId: swap.id, trailerId: null });
    const win = { start: new Date(NOW.getTime() + H), end: new Date(NOW.getTime() + 10 * H) };
    expect(await findTruckClash(hook.id, "other", win, W)).not.toBeNull(); // on the road with it
    expect(await findTruckClash(swap.id, "other", win, W)).not.toBeNull();
    await recordDrop(a.id, GOOD, NOW, W, null); // a hook: the truck leaves
    await recordDrop(b.id, { ...GOOD, type: "slip_seat" }, NOW, W, null); // a swap: the truck stays
    expect(await findTruckClash(hook.id, "other", win, W)).toBeNull();
    expect(await findTruckClash(swap.id, "other", win, W)).not.toBeNull();
  });

  test("a baton waiting in the yard raises an alert: a warning at an hour, a block at four, a block at once for a discrepancy", async () => {
    const load = await rolling("RL-12");
    const h = await recordDrop(load.id, GOOD, new Date(NOW.getTime() - 90 * 60_000), W, null);
    clearAlertCache();
    const codes = async () => (await getAlerts(NOW, W, "all")).alerts.filter((a) => a.loadId === load.id).map((a) => `${a.code}:${a.level}`);
    expect(await codes()).toContain("HANDOFF_WAITING:warn");
    await prisma.handoff.update({ where: { id: h.id }, data: { droppedAt: new Date(NOW.getTime() - 5 * H) } });
    clearAlertCache();
    expect(await codes()).toContain("HANDOFF_WAITING:block");
    await flagDiscrepancy(h.id, { notes: "Seal missing", raisedBy: "incoming_driver" }, NOW, W, null);
    clearAlertCache();
    expect(await codes()).toContain("HANDOFF_DISCREPANCY:block");
  });
});

describe.skipIf(!run)("a driver recalled while rolling empty keeps the miles they drove", () => {
  const P = "rl-p";
  const ids = { d: "", t: "" };
  const loadIds: string[] = [];

  async function accepted(label: string, pay: { kind: string; rate: number } = { kind: "cpm", rate: 0.6 }) {
    const load = await prisma.load.create({ data: { workspaceId: P, loadNumber: label, status: "draft", vehicleId: ids.t, quotedRevenue: 1500, loadedMiles: 800, stops: { create: [{ stopSequence: 1, stopType: "pickup", addressString: "Tulsa, OK", timeWindowEarliest: new Date(NOW.getTime() + 5 * D), timeWindowLatest: new Date(NOW.getTime() + 5 * D + 2 * H) }, { stopSequence: 2, stopType: "delivery", addressString: "Denver, CO", timeWindowEarliest: new Date(NOW.getTime() + 6 * D), timeWindowLatest: new Date(NOW.getTime() + 6 * D + 2 * H) }] } } });
    loadIds.push(load.id);
    await assignDriver({ loadId: load.id, driverId: ids.d, pay: { kind: pay.kind as "cpm", rate: pay.rate } }, NOW, P);
    await dispatchLoad(load.id, NOW, {}, P);
    return load;
  }

  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: P } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: P } } }, { driver: { workspace: { id: P } } }] } });
    await prisma.workspace.deleteMany({ where: { id: P } });
    await prisma.workspace.create({ data: { id: P, name: "Relay empty-recall fleet", plan: "enterprise" } });
    ids.d = (await prisma.driver.create({ data: { workspaceId: P, name: "RP Driver", cdlExpiry: new Date(NOW.getTime() + 400 * D), medicalCardExpiry: new Date(NOW.getTime() + 400 * D), defaultPayKind: "cpm", defaultPayRate: 0.55 } })).id;
    ids.t = (await prisma.vehicle.create({ data: { workspaceId: P, name: "RP Truck" } })).id;
  });
  afterAll(async () => {
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspaceId: P } }, { driver: { workspaceId: P } }] } });
    await prisma.workspace.deleteMany({ where: { id: P } });
  });

  test("the miles are kept on a closed positioning leg with their source, paid at the driver's own cents a mile, and the load is back in the bucket", async () => {
    const load = await accepted("RP-1");
    await recordDriverResponse(load.id, "accepted", NOW, undefined, P);
    await unassignLoad(load.id, "Wrong driver", NOW, P, null, "ASSIGNED_IN_ERROR", { milesDriven: 42, milesSource: "driver" });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("draft");
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(0);
    const [leg] = await legsOfLoad(load.id, P);
    expect(leg).toMatchObject({ seq: 1, kind: "positioning", status: "closed", driverName: "RP Driver", milesSource: "driver", payKind: "cpm" });
    expect(Number(leg!.milesDriven)).toBe(42);
    expect(Number(leg!.payRate)).toBe(0.6); // this assignment's per-mile rate
    expect(Number(leg!.payEstimate)).toBe(25.2);
  });

  test("with no miles known, the leg says so and the pay stays unknown; a flat-pay driver falls back to their own per-mile rate on record", async () => {
    const load = await accepted("RP-2", { kind: "flat", rate: 500 });
    await recordDriverResponse(load.id, "accepted", NOW, undefined, P);
    await unassignLoad(load.id, null, NOW, P, null, "HOS_TIMEOUT", { milesDriven: null, milesSource: null });
    const [leg] = await legsOfLoad(load.id, P);
    expect([leg!.milesDriven, leg!.milesSource, leg!.payEstimate]).toEqual([null, null, null]);
    expect(Number(leg!.payRate)).toBe(0.55); // from the driver's record, not the flat assignment
  });

  test("miles are refused without a source, out of range, or on a load the driver has not accepted", async () => {
    const load = await accepted("RP-3");
    await expect(unassignLoad(load.id, null, NOW, P, null, "HOS_TIMEOUT", { milesDriven: 50, milesSource: null })).rejects.toBeInstanceOf(DispatchError);
    await expect(unassignLoad(load.id, null, NOW, P, null, "HOS_TIMEOUT", { milesDriven: 9000, milesSource: "eld" })).rejects.toBeInstanceOf(DispatchError);
    await expect(unassignLoad(load.id, null, NOW, P, null, "HOS_TIMEOUT", { milesDriven: 50, milesSource: "eld" })).rejects.toBeInstanceOf(DispatchError); // sent, not accepted
    expect(await prisma.assignment.count({ where: { loadId: load.id } })).toBe(1);
    expect(await legsOfLoad(load.id, P)).toHaveLength(0);
  });

  test("after a positioning recall, reassigning and dropping opens seq 2 instead of colliding on seq 1", async () => {
    // Earlier tests leave this driver on other loads in the same window: clear them so the reassignment is not a double booking.
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: P } } });
    const load = await accepted("RP-4");
    await recordDriverResponse(load.id, "accepted", NOW, undefined, P);
    await unassignLoad(load.id, "Truck switched", NOW, P, null, "ASSIGNED_IN_ERROR", { milesDriven: 30, milesSource: "driver" });
    await assignDriver({ loadId: load.id, driverId: ids.d, pay: { kind: "cpm", rate: 0.6 } }, NOW, P);
    await dispatchLoad(load.id, NOW, {}, P);
    await recordDriverResponse(load.id, "accepted", NOW, undefined, P);
    await prisma.load.update({ where: { id: load.id }, data: { status: "in_progress" } });
    await prisma.assignment.update({ where: { loadId: load.id }, data: { status: "in_progress" } });
    await recordDrop(load.id, GOOD, NOW, P, null);
    const legs = await legsOfLoad(load.id, P);
    expect(legs.map((l) => [l.seq, l.kind, l.status])).toEqual([[1, "positioning", "closed"], [2, "haul", "closed"]]);
  });
});

describe.skipIf(!run)("Phase 3: relay settlement, lifecycle, and board chip", () => {
  const W3 = "rl-p3";
  const ids = { dA: "", dB: "", t1: "", t2: "", tSmall: "", trailer: "" };
  const base = new Date("2026-11-10T14:00:00.000Z");

  beforeAll(async () => {
    await prisma.settlementLeg.deleteMany({ where: { workspaceId: W3 } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W3 } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W3 } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspaceId: W3 } }, { driver: { workspaceId: W3 } }] } });
    await prisma.workspace.deleteMany({ where: { id: W3 } });
    await prisma.workspace.create({ data: { id: W3, name: "Relay Phase 3 fleet", plan: "enterprise", timezone: "America/Chicago" } });
    ids.dA = (await prisma.driver.create({ data: { workspaceId: W3, name: "P3 Driver A", cdlExpiry: new Date(NOW.getTime() + 400 * D), medicalCardExpiry: new Date(NOW.getTime() + 400 * D), defaultPayKind: "cpm", defaultPayRate: 0.6 } })).id;
    ids.dB = (await prisma.driver.create({ data: { workspaceId: W3, name: "P3 Driver B", cdlExpiry: new Date(NOW.getTime() + 400 * D), medicalCardExpiry: new Date(NOW.getTime() + 400 * D), defaultPayKind: "percent", defaultPayRate: 30, payArrangement: "contractor" } })).id;
    ids.t1 = (await prisma.vehicle.create({ data: { workspaceId: W3, name: "P3 Truck 1", payloadLbs: 45000 } })).id;
    ids.t2 = (await prisma.vehicle.create({ data: { workspaceId: W3, name: "P3 Truck 2", payloadLbs: 45000 } })).id;
    ids.tSmall = (await prisma.vehicle.create({ data: { workspaceId: W3, name: "P3 Small Truck", payloadLbs: 10000 } })).id;
    ids.trailer = (await prisma.trailer.create({ data: { workspaceId: W3, number: "P3-501" } })).id;
  });

  afterAll(async () => {
    await prisma.settlementLeg.deleteMany({ where: { workspaceId: W3 } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W3 } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W3 } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspaceId: W3 } }, { driver: { workspaceId: W3 } }] } });
    await prisma.workspace.deleteMany({ where: { id: W3 } });
  });

  async function startedLoad(label: string, pay: { kind: "cpm" | "flat" | "percent" | "hourly"; rate: number }, weightLbs = 30000) {
    const pickupAt = new Date(base.getTime() - 4 * H);
    const load = await prisma.load.create({
      data: {
        workspaceId: W3,
        loadNumber: label,
        status: "accepted",
        vehicleId: ids.t1,
        trailerId: ids.trailer,
        quotedRevenue: 1100,
        fuelSurcharge: 100,
        loadedMiles: 600,
        weightLbs,
        brokerName: "Relay Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Chicago, IL",
        scheduledDate: pickupAt,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: pickupAt, timeWindowLatest: new Date(pickupAt.getTime() + H) },
            { stopSequence: 2, stopType: "delivery", addressString: "Chicago, IL", timeWindowEarliest: new Date(base.getTime() + 10 * H), timeWindowLatest: new Date(base.getTime() + 14 * H) }
          ]
        }
      }
    });
    await assignDriver({ loadId: load.id, driverId: ids.dA, pay }, pickupAt, W3);
    await dispatchLoad(load.id, pickupAt, {}, W3);
    await recordDriverResponse(load.id, "accepted", pickupAt, undefined, W3);
    const st = await startTrip(load.id, { arrivedAt: toCentralLocal(pickupAt.getTime()), waitMinutes: "", seal: "S1" }, pickupAt, W3);
    expect(st).toEqual({ ok: true });
    return prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  }

  test("600-mi relay end-to-end: cpm drop at 250 + percent receive at 30% + deliver -> exact leg settlements, double-pay guard, locks, void", async () => {
    const load = await startedLoad("P3-600", { kind: "cpm", rate: 0.6 });
    const dropAt = new Date(base.getTime() + 2 * H);
    const h = await recordDrop(load.id, { type: "drop_hook", reason: "planned", locationName: "Tulsa yard", outgoingNext: "bobtail", milesDriven: 250, milesSource: "eld" }, dropAt, W3, null);

    // 3.6 Board shows Awaiting handoff and filters by status=handoff; 3.2 refuses delivery while handoff is open.
    const board = await listBoardRows(W3, "open", null);
    expect(board.find((r) => r.id === load.id)?.openHandoff).toEqual({ state: "dropped", locationName: "Tulsa yard" });
    expect(filterBoard(board, { status: "handoff" }).map((r) => r.id)).toContain(load.id);
    const delivLocal = toCentralLocal(new Date(base.getTime() + 8 * H).getTime());
    expect(await completeTrip(load.id, { deliveredAt: delivLocal, pod: "received", podNote: "Signed", fuel: "", tolls: "", misc: "", stops: [{ id: load.stops[1]!.id, arrivedAt: delivLocal, waitMinutes: "" }] }, new Date(base.getTime() + 8 * H), W3)).toMatchObject({ ok: false, error: expect.stringMatching(/Receive the handoff first/) });

    // 3.4 truckFit blocks undersized incoming truck; receive succeeds on full-size truck.
    await expect(receiveHandoff(h.id, { driverId: ids.dB, vehicleId: ids.tSmall, pay: { kind: "percent", rate: 30 } }, new Date(base.getTime() + 3 * H), W3, null)).rejects.toMatchObject({ code: "bad_handoff" });
    await receiveHandoff(h.id, { driverId: ids.dB, vehicleId: ids.t2, pay: { kind: "percent", rate: 30 } }, new Date(base.getTime() + 3 * H), W3, null);

    const deliverAt = new Date(base.getTime() + 8 * H);
    const delivered = await completeTrip(
      load.id,
      { deliveredAt: toCentralLocal(deliverAt.getTime()), pod: "received", podNote: "BOL signed", fuel: "", tolls: "", misc: "", stops: [{ id: load.stops[1]!.id, arrivedAt: toCentralLocal(deliverAt.getTime() - 1_800_000), waitMinutes: "10" }] },
      deliverAt,
      W3
    );
    expect(delivered).toEqual({ ok: true });

    const legs = await legsOfLoad(load.id, W3);
    expect(legs).toHaveLength(2);
    expect(Number(legs[0]!.payEstimate)).toBe(150); // 250 * 0.60
    expect(legs[1]!.milesSource).toBe("remainder");
    expect(Number(legs[1]!.milesDriven)).toBe(350); // 600 - 250
    expect(Number(legs[1]!.payEstimate)).toBe(210); // (1100 + 100) * 0.30 * 350 / 600

    // Eligibility & unsettled summary
    const [elA, elB, summs] = await Promise.all([
      eligibleLoads(ids.dA, "2026-11-01", "2026-11-30", W3),
      eligibleLoads(ids.dB, "2026-11-01", "2026-11-30", W3),
      unsettledByDriver(W3, deliverAt)
    ]);
    expect(elA.find((x) => x.loadLegId === legs[0]!.id)).toMatchObject({ loadId: load.id, legMiles: 250, payKind: "cpm", payRate: 0.6 });
    expect(elB.find((x) => x.loadLegId === legs[1]!.id)).toMatchObject({ loadId: load.id, legMiles: 350, payKind: "percent", payRate: 30 });
    expect(summs.find((u) => u.driverId === ids.dA)?.amount).toBe(150);
    expect(summs.find((u) => u.driverId === ids.dB)?.amount).toBe(210);

    // Finalize both drivers' statements
    const stA = await startSettlement({ driverId: ids.dA, start: "2026-11-01", end: "2026-11-30" }, deliverAt, W3);
    const stB = await startSettlement({ driverId: ids.dB, start: "2026-11-01", end: "2026-11-30" }, deliverAt, W3);
    expect(stA.ok && stB.ok).toBe(true);
    if (!stA.ok || !stB.ok) return;
    expect(await finalizeSettlement(stA.id, { hours: {}, adjustments: [] }, deliverAt, W3, 150)).toEqual({ ok: true, id: stA.id });
    expect(await finalizeSettlement(stB.id, { hours: {}, adjustments: [] }, deliverAt, W3, 210)).toEqual({ ok: true, id: stB.id });

    const info = await settlementsOfLoad(load.id);
    expect(info.whole).toBeNull();
    expect(info.legs.map((x) => x.amount)).toEqual([150, 210]);

    // DB unique guard prevents settling a leg twice
    await expect(
      prisma.settlementLeg.create({ data: { workspaceId: W3, settlementId: stA.id, loadLegId: legs[0]!.id, loadId: load.id, amount: 150 } })
    ).rejects.toMatchObject({ code: "P2002" });

    // onStatement locks block edits, expenses loaded miles, reopenDelivered, and delete
    expect(await deleteLoad({ loadId: load.id, reason: "mistake" }, deliverAt, W3, null)).toMatchObject({ ok: false });
    expect(await reopenDelivered(load.id, "wrong time", deliverAt, W3, null)).toMatchObject({ ok: false });
    expect(await saveExpenses(load.id, { fuel: "0", tolls: "0", misc: "0", miles: { pickup: "0", loaded: "610", home: "0" } }, deliverAt, W3, null)).toMatchObject({ ok: false });
    const fullLoad = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    const editInit = toEditValues(fullLoad);
    const editRes = await saveLoadDetails(
      load.id,
      {
        ...editInit,
        deal: editInit.deal ? { ...editInit.deal, rate: "1300" } : { vehicleId: ids.t2, rate: "1300", fuelSurcharge: "100", loadedMiles: "600", emptyToPickup: "0", emptyHome: "0" }
      },
      deliverAt,
      W3,
      null
    );
    expect(editRes).toMatchObject({ ok: false });

    // Voiding both releases both legs cleanly
    expect(await voidSettlement(stA.id, "Fixing leg 1", deliverAt, W3)).toEqual({ ok: true, id: stA.id });
    expect(await voidSettlement(stB.id, "Fixing leg 2", deliverAt, W3)).toEqual({ ok: true, id: stB.id });
    expect((await eligibleLoads(ids.dA, "2026-11-01", "2026-11-30", W3)).some((x) => x.loadLegId === legs[0]!.id)).toBe(true);
    expect((await eligibleLoads(ids.dB, "2026-11-01", "2026-11-30", W3)).some((x) => x.loadLegId === legs[1]!.id)).toBe(true);
  });

  test("flat relay requires leg flat amount on drop and records incoming flat amount on receive", async () => {
    const load = await startedLoad("P3-FLAT", { kind: "flat", rate: 500 });
    await expect(
      recordDrop(load.id, { type: "drop_hook", reason: "planned", locationName: "OKC yard", outgoingNext: "bobtail", milesDriven: 200, milesSource: "driver" }, base, W3, null)
    ).rejects.toMatchObject({ code: "bad_handoff" });
    const h = await recordDrop(load.id, { type: "drop_hook", reason: "planned", locationName: "OKC yard", outgoingNext: "bobtail", milesDriven: 200, milesSource: "driver", flatPay: 220 }, base, W3, null);
    await receiveHandoff(h.id, { driverId: ids.dB, vehicleId: ids.t2, pay: { kind: "flat", rate: 280 } }, new Date(base.getTime() + H), W3, null);
    const legs = await legsOfLoad(load.id, W3);
    expect(Number(legs[0]!.payEstimate)).toBe(220);
    expect(Number(legs[1]!.payEstimate)).toBe(280);
    const doneAt = new Date(base.getTime() + 6 * H);
    const doneLocal = toCentralLocal(doneAt.getTime());
    expect(
      await completeTrip(
        load.id,
        { deliveredAt: doneLocal, pod: "received", podNote: "Signed flat", fuel: "", tolls: "", misc: "", stops: [{ id: load.stops[1]!.id, arrivedAt: doneLocal, waitMinutes: "" }] },
        doneAt,
        W3
      )
    ).toEqual({ ok: true });
    const doneLegs = await legsOfLoad(load.id, W3);
    expect(Number(doneLegs[1]!.payEstimate)).toBe(280);
  });

  test("3.3 & 3.4: undoStartTrip refused once legs exist; cancel & TONU mark open handoffs cancelled; disputed refused until ack", async () => {
    const load1 = await startedLoad("P3-CANCEL", { kind: "cpm", rate: 0.6 });
    const h1 = await recordDrop(load1.id, { type: "drop_hook", reason: "hos", locationName: "Perryton", outgoingNext: "available_at_yard", milesDriven: 180, milesSource: "eld" }, base, W3, null);
    // Disputed cannot be received until acked
    await flagDiscrepancy(h1.id, { notes: "Door hinge bent", raisedBy: "incoming_driver" }, base, W3, null);
    await expect(receiveHandoff(h1.id, { driverId: ids.dB, vehicleId: ids.t2, pay: { kind: "cpm", rate: 0.65 } }, base, W3, null)).rejects.toMatchObject({ code: "not_receivable" });
    await cancelLoad({ loadId: load1.id, reason: "broker_cancelled" } as never, base, W3, null);
    expect((await prisma.handoff.findUniqueOrThrow({ where: { id: h1.id } })).state).toBe("cancelled");

    const load2 = await startedLoad("P3-UNDO", { kind: "cpm", rate: 0.6 });
    const h2 = await recordDrop(load2.id, { type: "slip_seat", reason: "planned", locationName: "Amarillo", outgoingNext: "available_at_yard" }, base, W3, null);
    await receiveHandoff(h2.id, { driverId: ids.dB, pay: { kind: "cpm", rate: 0.65 } }, new Date(base.getTime() + H), W3, null);
    expect(await undoStartTrip(load2.id, "Mistake", new Date(base.getTime() + 2 * H), W3, null)).toMatchObject({ ok: false, error: expect.stringMatching(/relay legs or handoffs/) });

    await recordTonu({ loadId: load2.id, reason: "shipper_not_ready", fee: 250 } as never, new Date(base.getTime() + 2 * H), W3, null);
    expect((await legsOfLoad(load2.id, W3)).every((l) => l.status === "closed")).toBe(true);
  });
});
