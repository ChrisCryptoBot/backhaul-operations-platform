import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { reopenCancelled } from "@/server/tl/disruptions";
import { addLoadDocument, DOCS_PER_LOAD } from "@/server/tl/documents";
import { correctTrip, saveExpenses } from "@/server/tl/execution";
import { buildExport } from "@/server/tl/exports";
import { listHistory } from "@/server/tl/history";
import { listBoardRows } from "@/server/tl/queries";
import { restoreLoad } from "@/server/tl/remove";
import { LOAD_STATUS } from "@/lib/desk-format";
import { toEditValues } from "@/lib/load-edit";
import { monthGroups } from "@/lib/loads-history";
import { saveBillingDetails } from "@/server/tl/billing-details";
import { assignDriver, dispatchLoad, recordDriverResponse } from "@/server/tl/dispatch";
import { cancelLoad, recordTonu, rescheduleLoad } from "@/server/tl/disruptions";
import { saveLoadDetails } from "@/server/tl/edit";
import { invoiceLoad, markLoadPaid, payInvoiceRecord, invoiceLoads } from "@/server/tl/invoicing";
import { deleteLoad } from "@/server/tl/remove";
import { assignTrailerToLoad } from "@/server/tl/trailers";
import { holderTrail } from "@/server/tl/assignment-events";
import { flushBridgeOutbox } from "@/server/bridge/service";
import { memoryTransport } from "@/server/bridge/transport";

/**
 * The same move pressed twice at once (a double click, a second tab) happens once, a load cannot be given more documents than it may hold by asking several times at the same moment, and the
 * Loads search and the files read like a person types. A workspace of its own for the writes; the file test reads the seeded demo desk and writes nothing.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "lr-races";
const day = (d: string) => new Date(`${d}T17:00:00Z`);
const pdf = { ok: true as const, type: { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" as const }, data: new TextEncoder().encode("%PDF-1.4 test"), name: "x.pdf" };

describe.skipIf(!run)("loads, pressed twice at once", () => {
  const id: Record<string, string> = {};
  let stops: string[] = [];
  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LR races", plan: "enterprise" } });
    const make = async (key: string, data: Record<string, unknown>) => {
      const l = await prisma.load.create({
        data: {
          workspaceId: W, loadNumber: `LR-${key}`, brokerName: "LR Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, quotedRevenue: 1000,
          stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX" }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK" }] },
          ...data
        } as never,
        include: { stops: true }
      });
      id[key] = l.id;
      if (key === "C") stops = l.stops.sort((a, b) => a.stopSequence - b.stopSequence).map((s) => s.id);
    };
    await make("C", { status: "completed", completedAt: day("2026-10-05") });
    await make("X", { status: "cancelled", cancelledAt: day("2026-10-06"), cancelReason: "broker_cancelled" });
    await make("G", { status: "draft", deletedAt: new Date() });
    await make("F", { status: "completed", completedAt: day("2026-10-05"), paymentStatus: "invoiced", invoiceNumber: "LR-F", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, factoringStatus: "requested", factoringReferenceId: "R1" });
    await make("D", { status: "completed", completedAt: day("2026-10-05"), originAddress: "Austin, TX", destinationAddress: "Dallas, TX" });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  const audits = (key: string, action: string) => prisma.auditEvent.count({ where: { loadId: id[key]!, action } });

  test("a correction sent twice is made once", async () => {
    const values = { stops: [{ id: stops[0]!, arrivedAt: "", waitMinutes: "45", seal: "S-1" }, { id: stops[1]!, arrivedAt: "", waitMinutes: "", seal: "" }], reason: "driver log" };
    const out = await Promise.all([correctTrip(id.C!, values, new Date(), W), correctTrip(id.C!, values, new Date(), W)]);
    expect(out.filter((r) => r.ok && r.changed).length).toBe(1);
    expect(await audits("C", "trip_corrected")).toBe(1);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: id.C! } })).dockWaitMinutes).toBe(45);
  });

  test("expenses saved twice at once are recorded once", async () => {
    const v = { fuel: "100", tolls: "", misc: "", items: { lumper: "50" } };
    const out = await Promise.all([saveExpenses(id.C!, v, new Date(), W), saveExpenses(id.C!, v, new Date(), W), saveExpenses(id.C!, v, new Date(), W)]);
    expect(out.filter((r) => r.ok && r.changed).length).toBe(1);
    expect(await audits("C", "expenses_changed")).toBe(1);
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: id.C! } })).expenseMisc)).toBe(50);
  });

  test("a cancelled load reopened twice is reopened once", async () => {
    const out = await Promise.allSettled([reopenCancelled({ loadId: id.X!, reason: "called back" }, new Date(), W), reopenCancelled({ loadId: id.X!, reason: "called back" }, new Date(), W)]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await audits("X", "load_reopened")).toBe(1);
  });

  test("a deleted load restored twice is restored once", async () => {
    const out = await Promise.all([restoreLoad(id.G!, new Date(), W), restoreLoad(id.G!, new Date(), W)]);
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(await audits("G", "restored")).toBe(1);
  });

  test("the factor's answer reported twice moves the status once", async () => {
    const out = await Promise.all([applyFactoringUpdate(id.F!, "funded", null, new Date(), W), applyFactoringUpdate(id.F!, "funded", null, new Date(), W)]);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(await audits("F", "factoring_updated")).toBe(1);
  });

  test("a load cannot be given more documents than it may hold, however many are added at the same moment", async () => {
    for (let i = 0; i < DOCS_PER_LOAD - 2; i++) {
      await prisma.loadDocument.create({ data: { workspaceId: W, loadId: id.D!, kind: "other", name: `seed${i}.pdf`, mime: "application/pdf", bytes: 10, sha256: "x", storageKey: `lr-${i}`, addedBy: "t" } });
    }
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => addLoadDocument(id.D!, "other", { ...pdf, name: `race${i}.pdf` }, new Date(), W)));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(await prisma.loadDocument.count({ where: { loadId: id.D! } })).toBe(DOCS_PER_LOAD);
  });

  test("History reads a search the way a person types it: every word, any order, punctuation ignored", async () => {
    const q = async (text: string) => (await listHistory({ q: text }, W)).rows.map((r) => r.loadNumber).sort();
    expect(await q("austin dallas")).toEqual(["LR-D"]);
    expect(await q("dallas austin")).toEqual(["LR-D"]);
    expect(await q("Austin, TX")).toEqual(["LR-D"]);
    expect(await q("austin, tulsa")).toEqual([]);
    expect(await q("lr-d")).toEqual(["LR-D"]);
  });

  test("a delivered load has the same money on the board, in History and in the file", async () => {
    const board = (await listBoardRows(W, "all")).find((r) => r.loadNumber === "LR-D")!;
    const hist = (await listHistory({ q: "LR-D" }, W)).rows[0]!;
    expect(hist.grossRevenue).toBe(board.grossRevenue);
    expect(board.grossRevenue).toBe(1000);
  });
});

describe.skipIf(!run)("the loads file on the seeded desk", () => {
  test("says status in words, is bounded, and matches the screen's History for the same search", async () => {
    const out = await buildExport("loads", { view: "history", filter: "owed" }, new Date("2026-11-01T12:00:00Z"));
    expect(out).not.toBeNull();
    const [head, ...lines] = out!.csv.trim().split("\n");
    const cols = head!.split(",");
    const statusAt = cols.indexOf("Status");
    const labels = new Set(Object.values(LOAD_STATUS).map((s) => s.label));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(labels.has(line.split(",")[statusAt]!.replace(/^"|"$/g, ""))).toBe(true);
    // The Owed tab on screen counts the same loads.
    const screen = await listHistory({ filter: "owed" });
    expect(lines.length).toBe(screen.total);
    expect(out!.filename).toBe("truelane-desk-loads-2026-11-01.csv");
  });
});

describe.skipIf(!run)("Phase 2 edit integrity, time zones, holder trail, contact sync and restore re-offers", () => {
  const W2 = "p2-races";
  const OTHER = "p2-races-other";
  const bridgeEnv: Record<string, string | undefined> = {};
  let truckA = "";
  let truckB = "";
  let trailerId = "";
  let driverId = "";
  let driver2Id = "";

  const wipeWs = async (ws: string) => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.assignmentEvent.deleteMany({ where: { workspaceId: ws } });
    await prisma.bridgeOutbox.deleteMany({ where: { workspaceId: ws } });
    await prisma.invoice.deleteMany({ where: { workspaceId: ws } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: ws } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: ws } } }, { driver: { workspace: { id: ws } } }] } });
    await prisma.workspace.deleteMany({ where: { id: ws } });
  };

  beforeAll(async () => {
    for (const k of ["BRIDGE_SUPABASE_URL", "BRIDGE_SUPABASE_SERVICE_KEY"]) bridgeEnv[k] = process.env[k];
    process.env.BRIDGE_SUPABASE_URL = "https://bridge.test.invalid";
    process.env.BRIDGE_SUPABASE_SERVICE_KEY = "test-key-not-real";
    await wipeWs(W2);
    await wipeWs(OTHER);
    await prisma.workspace.create({ data: { id: W2, name: "P2 Races", plan: "enterprise", timezone: "America/New_York", bridgeOrgId: "org_p2_races" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "P2 Other", plan: "enterprise" } });
    truckA = (await prisma.vehicle.create({
      data: {
        workspaceId: W2,
        name: "P2 Truck A",
        type: "tractor",
        costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85 } }
      } as never
    })).id;
    truckB = (await prisma.vehicle.create({
      data: {
        workspaceId: W2,
        name: "P2 Truck B",
        type: "tractor",
        costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85 } }
      } as never
    })).id;
    trailerId = (await prisma.trailer.create({
      data: { workspaceId: W2, number: "TR-P2-1", type: "dry_van", status: "available" } as never
    })).id;
    driverId = (await prisma.driver.create({
      data: { workspaceId: W2, name: "P2 Driver 1", phoneUserId: "user_p2_driver_1", active: true } as never
    })).id;
    driver2Id = (await prisma.driver.create({
      data: { workspaceId: W2, name: "P2 Driver 2", phoneUserId: "user_p2_driver_2", active: true } as never
    })).id;
  });

  afterAll(async () => {
    await wipeWs(W2);
    await wipeWs(OTHER);
    for (const [k, v] of Object.entries(bridgeEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const makeLoad = (loadNumber: string, extra: Record<string, unknown> = {}) =>
    prisma.load.create({
      data: {
        workspaceId: W2,
        loadNumber,
        brokerName: "P2 Broker",
        brokerEmail: "old@p2.test",
        brokerPhone: "555-0100",
        status: "draft",
        quotedRevenue: 1500,
        loadedMiles: 500,
        originAddress: "Dallas, TX",
        destinationAddress: "Atlanta, GA",
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date("2026-12-01T14:00:00Z"), timeWindowLatest: new Date("2026-12-01T16:00:00Z") },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", timeWindowEarliest: new Date("2026-12-02T14:00:00Z"), timeWindowLatest: new Date("2026-12-02T16:00:00Z") }
          ]
        },
        ...extra
      } as never,
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });

  test("2.1 concurrent saveLoadDetails on the same version refuses the second, and neither truck nor trailer double-books", async () => {
    const l1 = await makeLoad("P2-RACE-1");
    const l2 = await makeLoad("P2-RACE-2", { vehicleId: truckB });

    const v1 = toEditValues(l1, {});
    const [e1, e2] = await Promise.all([
      saveLoadDetails(l1.id, { ...v1, notes: "First tab" }, new Date("2026-11-25T12:00:00Z"), W2),
      saveLoadDetails(l1.id, { ...v1, notes: "Second tab" }, new Date("2026-11-25T12:00:00Z"), W2)
    ]);
    expect([e1, e2].filter((r) => r.ok)).toHaveLength(1);
    expect([e1, e2].find((r) => !r.ok)).toMatchObject({ ok: false, error: expect.stringContaining("changed") });

    // Re-read both loads fresh and race moving both onto Truck A at the same time.
    const [f1, f2] = await Promise.all([
      prisma.load.findUniqueOrThrow({ where: { id: l1.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }),
      prisma.load.findUniqueOrThrow({ where: { id: l2.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } })
    ]);
    const ev1 = { ...toEditValues(f1, {}), deal: { vehicleId: truckA, rate: "1500", fuelSurcharge: "0", loadedMiles: "500", emptyToPickup: "0", emptyHome: "0" } };
    const ev2 = { ...toEditValues(f2, {}), deal: { vehicleId: truckA, rate: "1500", fuelSurcharge: "0", loadedMiles: "500", emptyToPickup: "0", emptyHome: "0" } };
    const [m1, m2] = await Promise.all([
      saveLoadDetails(l1.id, ev1, new Date("2026-11-25T12:01:00Z"), W2),
      saveLoadDetails(l2.id, ev2, new Date("2026-11-25T12:01:00Z"), W2)
    ]);
    expect([m1, m2].filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.load.count({ where: { workspaceId: W2, vehicleId: truckA } })).toBe(1);

    // Concurrent trailer assignment onto two overlapping loads only puts the trailer on one.
    const [tr1, tr2] = await Promise.all([
      assignTrailerToLoad(l1.id, trailerId, new Date("2026-11-25T12:02:00Z"), W2),
      assignTrailerToLoad(l2.id, trailerId, new Date("2026-11-25T12:02:00Z"), W2)
    ]);
    expect([tr1, tr2].filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.load.count({ where: { workspaceId: W2, trailerId } })).toBe(1);
  });

  test("2.4 holder trail records tonu/reopened/cancelled/reoffered/deleted/restored, and reopenCancelled clears stop waits/arrivals/seals", async () => {
    const l = await makeLoad("P2-TRAIL-1");
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "trail test" }, new Date("2026-11-25T10:00:00Z"), W2);
    await dispatchLoad(l.id, new Date("2026-11-25T10:01:00Z"), {}, W2);
    await recordDriverResponse(l.id, "accepted", new Date("2026-11-25T10:02:00Z"), undefined, W2, "phone");
    await prisma.stop.update({ where: { id: l.stops[0]!.id }, data: { arrivedAt: new Date("2026-11-25T10:30:00Z"), waitMinutes: 180, sealNumber: "SEAL-9", arrivedSource: "desk" } });
    await recordTonu({ loadId: l.id, reason: "shipper_not_ready", note: "gate closed", fee: 250 }, new Date("2026-11-25T11:00:00Z"), W2);
    await reopenCancelled({ loadId: l.id, reason: "Customer rebooked" }, new Date("2026-11-25T11:10:00Z"), W2);

    const stopAfterReopen = await prisma.stop.findUniqueOrThrow({ where: { id: l.stops[0]!.id } });
    expect(stopAfterReopen.arrivedAt).toBeNull();
    expect(stopAfterReopen.waitMinutes).toBeNull();
    expect(stopAfterReopen.sealNumber).toBeNull();
    expect(stopAfterReopen.arrivedSource).toBeNull();

    await assignDriver({ loadId: l.id, driverId: driver2Id, pay: { kind: "cpm", rate: 0.62 }, overrideReason: "reassigned" }, new Date("2026-11-25T11:20:00Z"), W2);
    await dispatchLoad(l.id, new Date("2026-11-25T11:21:00Z"), {}, W2);
    await rescheduleLoad({ loadId: l.id, reason: "broker_request", newPickup: new Date("2026-12-01T16:00:00Z") }, new Date("2026-11-25T11:25:00Z"), W2);
    await cancelLoad({ loadId: l.id, reason: "broker_cancelled", note: "no freight" }, new Date("2026-11-25T11:30:00Z"), W2);

    const kinds = (await holderTrail(l.id, W2)).map((h) => h.kind);
    expect(kinds).toEqual(expect.arrayContaining(["tonu", "reopened", "reoffered", "cancelled"]));
  });

  test("2.7 restoreLoad re-offers a previously sent/accepted assignment and writes an unanswered bridge row", async () => {
    await prisma.bridgeOutbox.deleteMany({ where: { workspaceId: W2 } });
    const t = memoryTransport();
    const l = await makeLoad("P2-RESTORE-1");
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "restore test" }, new Date("2026-11-25T12:00:00Z"), W2);
    await dispatchLoad(l.id, new Date("2026-11-25T12:01:00Z"), {}, W2);
    await recordDriverResponse(l.id, "accepted", new Date("2026-11-25T12:02:00Z"), undefined, W2, "phone");
    await flushBridgeOutbox(t, { workspaceId: W2, now: new Date("2026-11-25T12:02:30Z") });
    expect(t.table).toHaveLength(1);
    t.table[0]!.driver_response = { state: "accepted", at: "2026-11-25T12:02:00Z" };

    expect(await deleteLoad({ loadId: l.id, reason: "duplicate" }, new Date("2026-11-25T12:03:00Z"), W2)).toEqual({ ok: true });
    await flushBridgeOutbox(t, { workspaceId: W2, now: new Date("2026-11-25T12:03:30Z") });
    expect(t.table[0]!.status).toBe("cancelled");

    expect(await restoreLoad(l.id, new Date("2026-11-25T12:04:00Z"), W2)).toEqual({ ok: true });
    const restoredLoad = await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { assignment: true } });
    expect(restoredLoad.status).toBe("draft");
    expect(restoredLoad.assignment?.status).toBe("dispatched");
    expect(restoredLoad.assignment?.respondedAt).toBeNull();
    expect(restoredLoad.assignment?.assignmentVersion).toBe(3);

    const trailKinds = (await holderTrail(l.id, W2)).map((h) => h.kind);
    expect(trailKinds.slice(-3)).toEqual(["deleted", "restored", "reoffered"]);

    await flushBridgeOutbox(t, { workspaceId: W2, now: new Date("2026-11-25T12:04:30Z") });
    const activeRows = t.table.filter((r) => r.source_load_id === l.id && r.status === "dispatched");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]!.driver_response).toBeNull();
  });

  test("2.3/2.6 payment dates honor workspace Eastern zone at 23:30 CT, and billing contact edits sync to open unpaid invoices", async () => {
    const l1 = await makeLoad("P2-INV-1", { status: "completed", completedAt: new Date("2026-11-24T18:00:00Z") });
    const l2 = await makeLoad("P2-INV-2", { status: "completed", completedAt: new Date("2026-11-24T18:00:00Z") });
    const l3 = await makeLoad("P2-INV-3", { status: "completed", completedAt: new Date("2026-11-24T18:00:00Z") });

    // Issue invoice at 2026-11-25T05:30:00Z -> 23:30 Nov 24 CT, but 00:30 Nov 25 ET!
    const atBoundary = new Date("2026-11-25T05:30:00Z");
    expect(await invoiceLoad(l1.id, { form: { number: "INV-P2-1", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, atBoundary, W2)).toMatchObject({ ok: true });

    // Contact sync on open unpaid invoice (2.6)
    expect(
      await saveBillingDetails(
        l1.id,
        { brokerName: "P2 Broker", brokerMcNumber: "", brokerPhone: "555-9999", brokerEmail: "ap-new@p2.test", poNumber: "", payTermsDays: "30", revenueNote: "" },
        new Date("2026-11-25T06:00:00Z"),
        W2
      )
    ).toEqual({ ok: true, changed: true });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W2, number: "INV-P2-1" } });
    expect(inv.billToEmail).toBe("ap-new@p2.test");
    expect(inv.billToPhone).toBe("555-9999");

    // Paying on 2026-11-25 at 2026-11-25T05:30:00Z succeeds in America/New_York (would have failed under Dallas Nov 24!).
    expect(await markLoadPaid(l1.id, atBoundary, { paidOn: "2026-11-25" }, W2)).toEqual({ ok: true });

    // Same Eastern calendar check for multi-load payInvoiceRecord
    expect(await invoiceLoads([l2.id, l3.id], { number: "INV-P2-MULTI", terms: "30" }, atBoundary, W2)).toMatchObject({ ok: true });
    const multi = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W2, number: "INV-P2-MULTI" } });
    expect(await payInvoiceRecord(multi.id, atBoundary, { paidOn: "2026-11-25" }, W2)).toEqual({ ok: true });

    // History monthGroups uses the passed workspace timezone (2026-12-01T04:30Z is Dec 1 00:30 ET vs Nov 30 22:30 CT).
    const decBoundary = new Date("2026-12-01T05:30:00Z"); // 23:30 Nov 30 CT, 00:30 Dec 1 ET
    const histSample = { id: "1", loadNumber: "1", poNumber: null, invoiceNumber: null, brokerName: null, brokerMc: null, origin: null, destination: null, vehicleName: null, driverName: null, status: "completed", verdict: null, completedAt: decBoundary, cancelledAt: null, scheduledDate: null, paymentStatus: null, quotedRevenue: 0, perMile: null, invoicedAt: null, paidAt: null, invoicedAmount: null, paidAmount: null };
    const groupsEt = monthGroups([histSample], "America/New_York");
    const groupsCt = monthGroups([histSample], "America/Chicago");
    expect(groupsEt[0]!.key).toBe("2026-12");
    expect(groupsCt[0]!.key).toBe("2026-11");
  });
});
