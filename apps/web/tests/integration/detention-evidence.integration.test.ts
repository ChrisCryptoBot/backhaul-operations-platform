import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toCentralLocal } from "@/lib/zoned";
import { purgeOldPings } from "@/server/partners/retention";
import { getDetentionRecovery } from "@/server/tl/detention";
import { confirmStopEvidence, dismissStopEvidence, freezeEvidence, freezeRecentDeliveries, getEvidencePack, listProposed } from "@/server/tl/detention-evidence";
import { completeTrip } from "@/server/tl/execution";

/**
 * The detention evidence pack in a workspace of its own: what a truck's track says about each stop is frozen at delivery, survives the week the fixes are kept, and changes nothing until a person confirms
 * it, when the stop's arrival and wait are written through the trip correction (audited, dock wait recomputed, picked up by the Invoices recovery). A person limited to a terminal never reads or decides
 * another's; an invoiced load refuses a write but can keep the evidence as proof; the evidence says when it has been edited.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/detention-evidence.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "dv-w";
const OTHER = "dv-other";
const NOW = new Date();
const MIN = 60_000;
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
const PU = { lat: 33.0, lng: -96.0 };
const DL = { lat: 33.5, lng: -96.5 };
const north = (p: { lat: number; lng: number }, miles: number) => ({ lat: p.lat + miles / 69.09, lng: p.lng });

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("detention evidence", () => {
  const ids = { dallas: "", memphis: "", l1: "", l1Pu: "", l1Dl: "", l5: "", l5Pu: "", l6: "", l7: "", l7Dl: "", other: "" };

  /** A delivered load of `vehicle`, picked up at `PU` and delivered at `DL`, with detention terms of $75 an hour past two hours. */
  const load = (n: string, vehicleId: string, over: Record<string, unknown> = {}) =>
    prisma.load.create({
      data: {
        workspaceId: W,
        vehicleId,
        loadNumber: n,
        status: "completed",
        completedAt: at(-120),
        quotedRevenue: 1000,
        scheduledDate: at(-1800),
        snapshotDetentionRate: 75,
        snapshotFreeGraceMinutes: 120,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", facilityName: "Shipper", lat: PU.lat, lng: PU.lng, timeWindowEarliest: at(-1800), timeWindowLatest: at(-1680) },
            { stopSequence: 2, stopType: "delivery", addressString: "Waco, TX", facilityName: "Receiver", lat: DL.lat, lng: DL.lng, timeWindowEarliest: at(-240), timeWindowLatest: at(-180) }
          ]
        },
        ...over
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });

  /** A truck's track: approach, a dwell at the pickup from -1770 to -1500 minutes (every 15), a quick stop at the delivery from -180 to -140 (every 10), and fixes just outside each. */
  const track = async (vehicleId: string, shift = 0) => {
    const fixes: Array<{ m: number; p: { lat: number; lng: number } }> = [{ m: -1785, p: north(PU, 0.8) }];
    for (let m = -1770; m <= -1500; m += 15) fixes.push({ m, p: north(PU, 0.05) });
    fixes.push({ m: -1485, p: north(PU, 0.8) }, { m: -190, p: north(DL, 0.8) });
    for (let m = -180; m <= -140; m += 10) fixes.push({ m, p: north(DL, 0.05) });
    fixes.push({ m: -130, p: north(DL, 0.8) });
    await prisma.vehiclePing.createMany({ data: fixes.map((f) => ({ workspaceId: W, vehicleId, lat: f.p.lat, lng: f.p.lng, at: at(f.m + shift) })) });
  };

  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "DV fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "DV other", plan: "enterprise" } });
    const dallas = await prisma.vehicle.create({ data: { workspaceId: W, name: "DV Dallas Truck", terminal: "Dallas" } });
    const memphis = await prisma.vehicle.create({ data: { workspaceId: W, name: "DV Memphis Truck", terminal: "Memphis" } });
    ids.dallas = dallas.id;
    ids.memphis = memphis.id;
    await track(dallas.id);
    const l1 = await load("DV-1", dallas.id);
    ids.l1 = l1.id;
    ids.l1Pu = l1.stops[0]!.id;
    ids.l1Dl = l1.stops[1]!.id;
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("freezing a delivered load keeps one row per placed stop, with the wait the track supports and what it is worth", async () => {
    expect(await freezeEvidence(ids.l1, NOW, W)).toEqual({ created: 2, improved: 0, unchanged: 0, noCoordinates: 0, noFixes: 0 });
    const pack = (await getEvidencePack(ids.l1, W, null))!;
    expect(pack.terms).toEqual({ ratePerHour: 75, freeMinutes: 120 });
    const [pu, dl] = pack.stops.map((s) => s.evidence!);
    expect(pu).toMatchObject({ state: "proposed", quality: "good", proposedWaitMinutes: 270, insideCount: 19, stillInside: false, beforeGapMin: 15, afterGapMin: 15, intact: true });
    expect(pu.proposedArrivalAt!.getTime()).toBe(at(-1770).getTime());
    expect(pu.proposedDepartureAt!.getTime()).toBe(at(-1500).getTime());
    expect(pu.worth).toEqual({ billableMinutes: 150, amount: 187.5 });
    expect(pu.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dl).toMatchObject({ quality: "good", proposedWaitMinutes: 40 });
    expect(dl.worth).toEqual({ billableMinutes: 0, amount: 0 });
    // Nothing on the stops or the load changed: a proposal changes nothing.
    const stops = await prisma.stop.findMany({ where: { loadId: ids.l1 } });
    expect(stops.every((s) => s.arrivedAt == null && s.waitMinutes == null)).toBe(true);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.l1 } })).dockWaitMinutes).toBeNull();
  });

  test("freezing again changes nothing, and the 7-day purge of the fixes leaves the proof intact (and a later freeze must not erase it)", async () => {
    expect(await freezeEvidence(ids.l1, NOW, W)).toMatchObject({ created: 0, improved: 0, unchanged: 2 });
    // The purge, run as of a month from now: every fix of this truck is older than a week.
    await purgeOldPings(at(30 * 24 * 60));
    expect(await prisma.vehiclePing.count({ where: { vehicleId: ids.dallas } })).toBe(0);
    expect(await freezeEvidence(ids.l1, NOW, W)).toMatchObject({ created: 0, improved: 0 });
    const pack = (await getEvidencePack(ids.l1, W, null))!;
    expect(pack.stops[0]!.evidence).toMatchObject({ quality: "good", proposedWaitMinutes: 270, intact: true });
    expect(pack.stops[0]!.evidence!.fixes).toHaveLength(21); // 19 inside and one outside either side
  });

  test("the proposals list is detention nobody has recorded: this stop, not the one under the free time; and a person limited elsewhere sees none", async () => {
    const dallas = await listProposed(["Dallas"], W);
    expect(dallas.map((r) => [r.loadNumber, r.stop, r.proposedWaitMinutes, r.amount, r.enteredWaitMinutes])).toEqual([["DV-1", 1, 270, 187.5, null]]);
    expect(await listProposed(["Memphis"], W)).toEqual([]);
    expect((await listProposed(null, W)).length).toBe(1);
  });

  test("a person limited to another terminal cannot read or decide this evidence by id", async () => {
    expect(await getEvidencePack(ids.l1, W, ["Memphis"])).toBeNull();
    const evidenceId = (await prisma.stopEvidence.findUniqueOrThrow({ where: { stopId: ids.l1Pu } })).id;
    expect(await confirmStopEvidence(evidenceId, {}, NOW, W, ["Memphis"])).toEqual({ ok: false, error: "That evidence is no longer on the desk." });
    expect(await dismissStopEvidence(evidenceId, "not ours", NOW, W, ["Memphis"])).toEqual({ ok: false, error: "That evidence is no longer on the desk." });
    expect(await getEvidencePack(ids.l1, W, ["Dallas"])).not.toBeNull();
    // Another desk's loads and evidence are never read.
    expect(await getEvidencePack(ids.l1, OTHER, null)).toBeNull();
    expect(await confirmStopEvidence(evidenceId, {}, NOW, OTHER, null)).toMatchObject({ ok: false });
    expect(await listProposed(null, OTHER)).toEqual([]);
  });

  test("confirming as the track showed writes the stop's arrival and wait through the trip correction: audited, dock wait recomputed, and the Invoices recovery sees it", async () => {
    const evidenceId = (await prisma.stopEvidence.findUniqueOrThrow({ where: { stopId: ids.l1Pu } })).id;
    expect(await confirmStopEvidence(evidenceId, {}, NOW, W, null)).toEqual({ ok: true, changed: true });
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id: ids.l1Pu } });
    expect(stop.waitMinutes).toBe(270);
    // The correction takes times to the minute, as everything typed on a stop is: the seconds of the fix are dropped.
    expect(stop.arrivedAt!.getTime()).toBe(Math.floor(at(-1770).getTime() / MIN) * MIN);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.l1 } })).dockWaitMinutes).toBe(270);
    const e = await prisma.stopEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
    expect(e).toMatchObject({ state: "confirmed", decidedBy: "Dispatcher", edited: false, wroteToStop: true, confirmedWaitMinutes: 270 });
    const audits = await prisma.auditEvent.findMany({ where: { workspaceId: W, loadId: ids.l1 }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["trip_corrected", "detention_evidence_confirmed"]));
    expect(audits.find((a) => a.action === "trip_corrected")!.reason).toContain("Detention evidence confirmed");
    // Now a typed wait like any other: the recovery list carries it.
    const recovery = await getDetentionRecovery(W, NOW);
    expect(JSON.stringify(recovery)).toContain("DV-1");
    expect(JSON.stringify(recovery)).toContain("187.5");
    // And it is no longer a proposal.
    expect(await listProposed(null, W)).toEqual([]);
    // Deciding twice is refused.
    expect(await confirmStopEvidence(evidenceId, {}, NOW, W, null)).toEqual({ ok: false, error: "Already confirmed." });
    expect(await dismissStopEvidence(evidenceId, "changed my mind", NOW, W, null)).toEqual({ ok: false, error: "Already confirmed." });
  });

  test("a changed figure needs a few words on why, is marked edited, and is what is written; a track with no wait must be given one", async () => {
    const dl = await prisma.stopEvidence.findUniqueOrThrow({ where: { stopId: ids.l1Dl } });
    const bad = await confirmStopEvidence(dl.id, { waitMinutes: "95" }, NOW, W, null);
    expect(bad).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: ids.l1Dl } })).waitMinutes).toBeNull();
    expect(await confirmStopEvidence(dl.id, { waitMinutes: "abc", note: "typed badly" }, NOW, W, null)).toMatchObject({ ok: false, errors: { waitMinutes: expect.any(String) } });
    expect(await confirmStopEvidence(dl.id, { waitMinutes: "95", note: "Dock log says 95" }, NOW, W, null)).toEqual({ ok: true, changed: true });
    const e = await prisma.stopEvidence.findUniqueOrThrow({ where: { id: dl.id } });
    expect(e).toMatchObject({ state: "confirmed", edited: true, confirmedWaitMinutes: 95, note: "Dock log says 95" });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: ids.l1Dl } })).waitMinutes).toBe(95);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.l1 } })).dockWaitMinutes).toBe(365);
  });

  test("a load that has been invoiced refuses to be rewritten, says so, and can keep the evidence as proof only", async () => {
    await track(ids.memphis, -2); // a second truck, its track a little earlier
    const l5 = await load("DV-5", ids.memphis, { paymentStatus: "invoiced", invoicedAt: at(-60), invoicedAmount: 1000 });
    ids.l5 = l5.id;
    ids.l5Pu = l5.stops[0]!.id;
    expect(await freezeEvidence(l5.id, NOW, W)).toMatchObject({ created: 2 });
    const e = await prisma.stopEvidence.findUniqueOrThrow({ where: { stopId: ids.l5Pu } });
    const refused = await confirmStopEvidence(e.id, {}, NOW, W, null);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(/invoiced/);
    expect((refused as { error: string }).error).toMatch(/proof only/);
    expect((await prisma.stopEvidence.findUniqueOrThrow({ where: { id: e.id } })).state).toBe("proposed");
    expect(await confirmStopEvidence(e.id, { proofOnly: true }, NOW, W, null)).toEqual({ ok: true, changed: true });
    expect(await prisma.stopEvidence.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ state: "confirmed", wroteToStop: false, confirmedWaitMinutes: 270 });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: ids.l5Pu } })).waitMinutes).toBeNull();
  });

  test("dismissing needs a reason, writes nothing to the stop, and is audited", async () => {
    const l6 = await load("DV-6", ids.dallas, { completedAt: at(-100) });
    ids.l6 = l6.id;
    await prisma.vehiclePing.deleteMany({ where: { vehicleId: ids.dallas } });
    await track(ids.dallas, 5);
    expect(await freezeEvidence(l6.id, NOW, W)).toMatchObject({ created: 2 });
    const e = await prisma.stopEvidence.findUniqueOrThrow({ where: { stopId: l6.stops[0]!.id } });
    expect(await dismissStopEvidence(e.id, "no", NOW, W, null)).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(await dismissStopEvidence(e.id, "Receiver confirmed the dock was empty", NOW, W, null)).toEqual({ ok: true, changed: true });
    expect(await prisma.stopEvidence.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ state: "dismissed", note: "Receiver confirmed the dock was empty", decidedBy: "Dispatcher" });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: l6.stops[0]!.id } })).waitMinutes).toBeNull();
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, loadId: l6.id, action: "detention_evidence_dismissed" } })).toBe(1);
    // A decided stop is never re-frozen.
    expect(await freezeEvidence(l6.id, NOW, W)).toMatchObject({ created: 0, improved: 0, unchanged: 2 });
  });

  test("delivering a load freezes its evidence; a stop with no coordinates is counted, not given a row", async () => {
    await prisma.vehiclePing.deleteMany({ where: { vehicleId: ids.dallas } });
    await track(ids.dallas, 60); // the delivery is entered an hour later than the first test's
    const l7 = await prisma.load.create({
      data: {
        workspaceId: W,
        vehicleId: ids.dallas,
        loadNumber: "DV-7",
        status: "in_progress",
        quotedRevenue: 800,
        scheduledDate: at(-1700),
        snapshotDetentionRate: 75,
        snapshotFreeGraceMinutes: 120,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", lat: PU.lat, lng: PU.lng, timeWindowEarliest: at(-1740), timeWindowLatest: at(-1680) },
            { stopSequence: 2, stopType: "delivery", addressString: "Somewhere, TX", timeWindowEarliest: at(-240), timeWindowLatest: at(-180) }
          ]
        }
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });
    ids.l7 = l7.id;
    ids.l7Dl = l7.stops[1]!.id;
    const out = await completeTrip(l7.id, { stops: [{ id: l7.stops[1]!.id, arrivedAt: toCentralLocal(NOW.getTime() - 130 * MIN), waitMinutes: "" }], deliveredAt: toCentralLocal(NOW.getTime() - 60 * MIN), pod: "received", podNote: "Signed BOL", fuel: "", tolls: "", misc: "" }, NOW, W);
    expect(out).toEqual({ ok: true });
    const rows = await prisma.stopEvidence.findMany({ where: { loadId: l7.id } });
    expect(rows.map((r) => r.stopId)).toEqual([l7.stops[0]!.id]);
    expect(rows[0]).toMatchObject({ state: "proposed", quality: "good" });
    expect(await freezeEvidence(l7.id, NOW, W)).toMatchObject({ created: 0, noCoordinates: 1 });
  });

  test("the catch-up freezes a delivered load that was missed, and leaves alone a truck that has no fixes", async () => {
    const quiet = await prisma.vehicle.create({ data: { workspaceId: W, name: "DV Quiet Truck", terminal: "Dallas" } });
    await load("DV-8", quiet.id, { completedAt: at(-200) }); // no fixes at all
    await prisma.vehiclePing.deleteMany({ where: { vehicleId: ids.memphis } });
    await track(ids.memphis, 0);
    const missed = await load("DV-9", ids.memphis, { completedAt: at(-120) });
    const out = await freezeRecentDeliveries(NOW, W);
    expect(out).toMatchObject({ failed: 0 });
    expect(out.loads).toBe(1);
    expect(out.created).toBe(2);
    expect(await prisma.stopEvidence.count({ where: { loadId: missed.id } })).toBe(2);
    expect(await prisma.stopEvidence.count({ where: { workspaceId: W, load: { loadNumber: "DV-8" } } })).toBe(0);
    // Run again: nothing is selected.
    expect((await freezeRecentDeliveries(NOW, W)).loads).toBe(0);
  });

  test("a truck that was seen but never near the stop leaves a row that says so", async () => {
    const far = await prisma.vehicle.create({ data: { workspaceId: W, name: "DV Far Truck", terminal: "Dallas" } });
    await prisma.vehiclePing.createMany({ data: [-200, -190, -180].map((m) => ({ workspaceId: W, vehicleId: far.id, lat: 40.0, lng: -100.0, at: at(m) })) });
    const l = await load("DV-10", far.id, { completedAt: at(-150) });
    expect(await freezeEvidence(l.id, NOW, W)).toMatchObject({ created: 2, noFixes: 0 });
    expect(await prisma.stopEvidence.findMany({ where: { loadId: l.id } })).toEqual(expect.arrayContaining([expect.objectContaining({ quality: "none", fixCount: 0, proposedWaitMinutes: null })]));
  });

  test("evidence that was edited after it was frozen says so: the hash no longer matches", async () => {
    const e = await prisma.stopEvidence.findFirstOrThrow({ where: { stopId: ids.l5Pu } });
    const fixes = e.fixes as Array<{ at: number }>;
    await prisma.stopEvidence.update({ where: { id: e.id }, data: { fixes: fixes.map((f, i) => (i === 3 ? { ...f, at: f.at + MIN } : f)) } });
    const pack = (await getEvidencePack(ids.l5, W, null))!;
    expect(pack.stops[0]!.evidence!.intact).toBe(false);
    expect((await getEvidencePack(ids.l1, W, null))!.stops[0]!.evidence!.intact).toBe(true);
  });
});
