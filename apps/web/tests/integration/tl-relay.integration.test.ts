import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { DispatchError, assignDriver, dispatchLoad, findTruckClash, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { RelayError, acknowledgeDiscrepancy, flagDiscrepancy, handoffsOfLoad, legsOfLoad, openHandoffs, receiveHandoff, recordDrop } from "@/server/tl/relay";
import { holderTrail } from "@/server/tl/assignment-events";
import { listLoadAudit } from "@/server/tl/audit";
import { cancelLoad } from "@/server/tl/disruptions";
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
    expect(Number(leg1!.payEstimate)).toBe(720); // the pay as it stood

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

    const tr = await prisma.trailer.findUniqueOrThrow({ where: { id: ids.trailer } });
    expect([tr.currentVehicleId, tr.dwellWaived, tr.unhookedAt]).toEqual([nx.truck, false, null]);

    expect((await holderTrail(load.id, W)).map((e) => e.kind)).toEqual(["dropped", "received"]);
    expect((await listLoadAudit(load.id, 25, W)).map((e) => e.action)).toEqual(expect.arrayContaining(["handoff_dropped", "handoff_received"]));
    expect((await openHandoffs(W, null, NOW)).some((o) => o.loadId === load.id)).toBe(false);
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
});
