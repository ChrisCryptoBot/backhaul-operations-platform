import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toEditValues } from "@/lib/load-edit";
import { BLANK_QUOTE } from "@/lib/quote";
import { buildPacket } from "@/server/partners/factoring-packet";
import { listLoadCheckCalls, logCheckCall, removeCheckCall } from "@/server/tl/check-calls";
import { createLoadClaim, listLoadClaims, removeLoadClaim, updateLoadClaim } from "@/server/tl/claims";
import { rescheduleLoad } from "@/server/tl/disruptions";
import { addLoadDocument } from "@/server/tl/documents";
import { saveLoadDetails } from "@/server/tl/edit";
import { buildExport } from "@/server/tl/exports";
import { invoiceLoad, issueSupplemental, unbilledExtrasOfLoad } from "@/server/tl/invoicing";
import { listBoardRows } from "@/server/tl/queries";
import { bookQuote, getQuoteLike } from "@/server/tl/quote";
import { searchDesk } from "@/server/tl/search";
import { findTwinLoad } from "@/server/tl/twins";

/**
 * Phase 6 end-to-end DB integration tests against `demo_gate` (RUN_DB_INTEGRATION=true).
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "p6-ops-w";
const NOW = new Date("2027-02-10T18:00:00Z"); // 12:00 PM Dallas

async function blankPdfBytes(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe.skipIf(!run)("Phase 6 operations integration on demo_gate", () => {
  let vehicleId = "";
  let driverId = "";

  async function wipe() {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.loadClaim.deleteMany({ where: { workspaceId: W } });
    await prisma.checkCall.deleteMany({ where: { workspaceId: W } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  }

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Phase 6 Test Fleet", plan: "enterprise", timezone: "America/Chicago" } });
    const v = await prisma.vehicle.create({
      data: {
        workspaceId: W,
        name: "P6-TRUCK",
        type: "dry_van",
        terminal: "Dallas",
        mpg: 7,
        fuelType: "diesel",
        costProfile: { create: { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.5, detentionHourlyRate: 75, freeGraceMinutes: 120 } }
      }
    });
    vehicleId = v.id;
    const d = await prisma.driver.create({
      data: { workspaceId: W, name: "P6 Driver", assignedVehicleId: vehicleId }
    });
    driverId = d.id;
  });

  afterAll(async () => {
    await wipe();
  });

  test("6.1: Check calls log to a load, appear in listLoadCheckCalls, and can be removed", async () => {
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        vehicleId,
        loadNumber: "P6-CC-1",
        status: "in_progress",
        originAddress: "Dallas, TX",
        destinationAddress: "Memphis, TN",
        loadedMiles: 450,
        quotedRevenue: 1400
      }
    });
    const res = await logCheckCall(
      { unit: { kind: "truck", id: vehicleId }, at: "2027-02-10T11:30", place: "I-30 Texarkana", status: "on_time", spokeWith: "Driver", note: "Rolling steady", loadId: load.id },
      NOW,
      W
    );
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;

    const list = await listLoadCheckCalls(load.id, W);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ place: "I-30 Texarkana", status: "on_time", spokeWith: "Driver", note: "Rolling steady", unitLabel: "Truck P6-TRUCK" });

    const del = await removeCheckCall(res.id, W);
    expect(del).toEqual({ ok: true });
    expect(await listLoadCheckCalls(load.id, W)).toHaveLength(0);
  });

  test("6.2 & 6.3 & A1: mid-trip stop edit/add with reason+fee, visited sequence lock, reschedule stopIds, freight/ref fields & board search", async () => {
    const tPu = new Date("2027-02-10T14:00:00Z");
    const tDel = new Date("2027-02-11T16:00:00Z");
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        vehicleId,
        loadNumber: "P6-MID-1",
        brokerName: "Delta Freight",
        status: "in_progress",
        originAddress: "Dallas, TX",
        destinationAddress: "Little Rock, AR",
        loadedMiles: 320,
        quotedRevenue: 1100,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: tPu, arrivedAt: new Date("2027-02-10T14:15:00Z"), waitMinutes: 20, sealNumber: "SEAL1", referenceNumbers: ["PU1"] },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Little Rock, AR", timeWindowEarliest: tDel, referenceNumbers: ["DL1"] }
          ]
        },
        assignment: { create: { driverId, status: "in_progress", payKind: "cpm", payRate: 0.6 } }
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });

    const editVals = toEditValues(load);
    // Refuses changing unvisited stop on in_progress load without a stopChangeReason.
    const noReason = await saveLoadDetails(
      load.id,
      {
        ...editVals,
        stops: [
          editVals.stops[0]!,
          { ...editVals.stops[1]!, address: "Memphis, TN" }
        ]
      },
      NOW,
      W
    );
    expect(noReason).toMatchObject({ ok: false, error: expect.stringMatching(/has started/i) });

    // Refuses editing a visited stop even with a reason.
    const editVisited = await saveLoadDetails(
      load.id,
      {
        ...editVals,
        stopChangeReason: "reconsignment",
        stops: [
          { ...editVals.stops[0]!, address: "Fort Worth, TX" },
          editVals.stops[1]!
        ]
      },
      NOW,
      W
    );
    expect(editVisited).toMatchObject({ ok: false, error: expect.stringMatching(/visited stops/i) });

    // Succeeds adding an unvisited drop + saving RC/PRO/BOL & freight/reefer/hazmat specs + fee.
    const withNewDrop = await saveLoadDetails(
      load.id,
      {
        ...editVals,
        rateConNumber: "RC-7771",
        proNumber: "PRO-8882",
        bolNumber: "BOL-9993",
        commodity: "Frozen poultry",
        pieceCount: "250",
        palletCount: "18",
        reeferSetTempF: "-10",
        reeferMinF: "-15",
        reeferMaxF: "0",
        reeferMode: "continuous",
        hazmat: "3",
        hazmatUnNumber: "UN1993",
        hazmatPackingGroup: "III",
        hazmatEmergencyPhone: "800-424-9300",
        stopChangeReason: "stop_added",
        stopChangeFee: "175",
        stops: [
          editVals.stops[0]!,
          editVals.stops[1]!,
          {
            id: "new:drop2",
            role: "delivery",
            address: "Memphis, TN",
            earliest: "2027-02-11T14:00",
            latest: "",
            facility: "Memphis Hub",
            refs: "DL2",
            contactName: "Sam",
            contactPhone: "555-0199",
            notes: "Added mid-trip"
          }
        ]
      },
      NOW,
      W
    );
    expect(withNewDrop).toMatchObject({ ok: true, changed: true });

    const updated = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(updated.stops).toHaveLength(3);
    expect(updated.stops[0]).toMatchObject({ id: load.stops[0]!.id, stopSequence: 1, sealNumber: "SEAL1", waitMinutes: 20 });
    expect(updated.stops[1]).toMatchObject({ id: load.stops[1]!.id, stopSequence: 2, addressString: "Little Rock, AR" });
    expect(updated.stops[2]).toMatchObject({ stopSequence: 3, addressString: "Memphis, TN" });
    expect(updated).toMatchObject({
      rateConNumber: "RC-7771",
      proNumber: "PRO-8882",
      bolNumber: "BOL-9993",
      commodity: "Frozen poultry",
      pieceCount: 250,
      palletCount: 18,
      reeferMode: "continuous",
      hazmatClass: "3",
      hazmatUnNumber: "UN1993",
      hazmatPackingGroup: "III"
    });

    // Unbilled reconsignment fee is tracked and flows into invoiceLoad.
    expect(await unbilledExtrasOfLoad(load.id, W)).toHaveLength(1);

    // Reschedule unvisited stop 2 & 3 only via stopIds; visited stop 1 stays untouched and cannot be included.
    await expect(
      rescheduleLoad({ loadId: load.id, reason: "broker_request", newPickup: new Date("2027-02-11T18:00:00Z"), stopIds: [updated.stops[0]!.id] }, NOW, W)
    ).rejects.toThrow(/Visited stops/);

    await rescheduleLoad(
      { loadId: load.id, reason: "broker_request", newPickup: new Date("2027-02-11T18:00:00Z"), stopIds: [updated.stops[1]!.id, updated.stops[2]!.id] },
      NOW,
      W
    );
    const afterResched = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(afterResched.stops[0]!.timeWindowEarliest!.getTime()).toBe(tPu.getTime());
    expect(afterResched.stops[1]!.timeWindowEarliest!.getTime()).toBe(new Date("2027-02-11T18:00:00Z").getTime());

    // Search finds the load by rateConNumber, proNumber, and bolNumber, and boardRowOf carries them.
    const board = await listBoardRows(W, "open");
    const boardRow = board.find((r) => r.id === load.id);
    expect(boardRow).toMatchObject({ rateConNumber: "RC-7771", proNumber: "PRO-8882", bolNumber: "BOL-9993", billedExtrasTotal: 175 });
    for (const term of ["RC-7771", "PRO-8882", "BOL-9993"]) {
      const hits = await searchDesk(term, W);
      expect(hits.some((h) => h.href === `/loads/${load.id}`)).toBe(true);
    }

    // Complete load & invoice: includes the $175 mid-trip extra automatically ($1100 + $175 = $1275), leaving 0 unbilled extras.
    await prisma.load.update({ where: { id: load.id }, data: { status: "completed", completedAt: new Date("2027-02-11T22:00:00Z"), podNote: "Signed" } });
    const inv = await invoiceLoad(
      load.id,
      { form: { number: "INV-P6-MID1", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } },
      NOW,
      W
    );
    expect(inv).toMatchObject({ ok: true, total: 1275 });
    expect(await unbilledExtrasOfLoad(load.id, W)).toHaveLength(0);

    // Adding a post-invoice stop fee flows into unbilledExtrasOfLoad -> supplemental invoice.
    const latestVals = toEditValues(await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
    await saveLoadDetails(load.id, { ...latestVals, stopChangeReason: "reconsignment", stopChangeFee: "50" }, NOW, W);
    const remainingExtras = await unbilledExtrasOfLoad(load.id, W);
    expect(remainingExtras).toHaveLength(1);
    const primaryInv = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "INV-P6-MID1" } });
    const supp = await issueSupplemental(primaryInv.id, [{ kind: "stop_off", label: remainingExtras[0]!.label, amount: remainingExtras[0]!.amount, loadId: load.id }], { reason: "Late reconsignment fee" }, NOW, W);
    expect(supp).toMatchObject({ ok: true, total: 50 });
    expect(await unbilledExtrasOfLoad(load.id, W)).toHaveLength(0);
  });

  test("6.4: OS&D claims persist +30d/+120d deadlines, update status, and can be removed", async () => {
    const load = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "P6-CLM-1", brokerName: "Claim Broker", status: "completed", completedAt: NOW, originAddress: "Dallas, TX", destinationAddress: "Houston, TX", quotedRevenue: 900 }
    });
    const created = await createLoadClaim(load.id, { type: "shortage", pieces: "2", amount: "310.00", externalNumber: "CLM-77", openedAt: "2027-02-01", note: "2 cartons short" }, NOW, W);
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;

    const list = await listLoadClaims(load.id, W);
    expect(list).toHaveLength(1);
    const clm = list[0]!;
    expect(clm).toMatchObject({ type: "shortage", pieces: 2, amount: 310, claimant: "Claim Broker", externalNumber: "CLM-77", status: "open" });
    expect((clm.ackBy.getTime() - clm.openedAt.getTime()) / 86_400_000).toBe(30);
    expect((clm.decideBy.getTime() - clm.openedAt.getTime()) / 86_400_000).toBe(120);

    expect(await updateLoadClaim(created.id, { status: "acknowledged", note: "Carrier acknowledged" }, NOW, W)).toEqual({ ok: true, id: created.id });
    expect((await listLoadClaims(load.id, W))[0]).toMatchObject({ status: "acknowledged", note: "Carrier acknowledged" });

    expect(await removeLoadClaim(created.id, NOW, W)).toEqual({ ok: true, id: created.id });
    expect(await listLoadClaims(load.id, W)).toHaveLength(0);
  });

  test("6.5 & 6.6: bookQuote links/creates Customer, findTwinLoad matches by customerId + RC#, and getQuoteLike preserves stop/freight details", async () => {
    const booked = await bookQuote(
      {
        ...BLANK_QUOTE,
        broker: "Coyote Logistics",
        loadNumber: "CL-101",
        rateConNumber: "RC-CL-901",
        proNumber: "PRO-CL-50",
        poNumber: "PO-77",
        offer: "1600",
        loadedMiles: "400",
        fuelPrice: "3.80",
        marketRate: "1600",
        commodity: "Bottled beverages",
        stops: [
          { role: "pickup", address: "Dallas, TX", appointment: "2027-03-01T08:00", facility: "Cold Warehouse", contactName: "Bob", contactPhone: "555-0101", notes: "Check in gate 2" },
          { role: "delivery", address: "San Antonio, TX", appointment: "2027-03-01T15:00", facility: "HEB Dock", contactName: "Sue", contactPhone: "555-0202", notes: "Pallet jack" }
        ]
      },
      { vehicleId, driverId: null },
      null,
      null,
      W,
      NOW
    );
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const loaded = await prisma.load.findUniqueOrThrow({ where: { id: booked.loadId }, include: { customer: true } });
    expect(loaded.customerId).toBeTruthy();
    expect(loaded.customer?.name).toBe("Coyote Logistics");

    // Same customerId matches even with different broker text casing/spacing, and matches across rateConNumber!
    const twinByNum = await findTwinLoad(W, "CL-101", "COYOTE   LOGISTICS", undefined, prisma, loaded.customerId);
    expect(twinByNum?.id).toBe(loaded.id);
    const twinByRc = await findTwinLoad(W, null, "COYOTE LOGISTICS", undefined, prisma, loaded.customerId, "RC-CL-901");
    expect(twinByRc?.id).toBe(loaded.id);

    // Book again copies facility, contact, notes, commodity, and money while clearing dates and all reference numbers.
    const like = await getQuoteLike(loaded.id, W);
    expect(like).not.toBeNull();
    expect(like!.loadNumber).toBe("");
    expect(like!.poNumber).toBe("");
    expect(like!.rateConNumber).toBe("");
    expect(like!.proNumber).toBe("");
    expect(like!.commodity).toBe("Bottled beverages");
    expect(like!.stops[0]).toMatchObject({ appointment: "", facility: "Cold Warehouse", contactName: "Bob", contactPhone: "555-0101", notes: "Check in gate 2" });
    expect(like!.stops[1]).toMatchObject({ appointment: "", facility: "HEB Dock", contactName: "Sue", contactPhone: "555-0202", notes: "Pallet jack" });
  });

  test("6.7 & 6.8: packet requires per-stop PODs, includes lumper, supports supplemental invoiceId, and export filters by ids", async () => {
    const l1 = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "P6-PKT-1",
        brokerName: "Packet Broker",
        status: "completed",
        completedAt: NOW,
        originAddress: "Dallas, TX",
        destinationAddress: "Houston, TX",
        loadedMiles: 250,
        quotedRevenue: 1000,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX" },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Waco, TX" },
            { stopSequence: 3, stopType: "delivery", stopRole: "delivery", addressString: "Houston, TX" }
          ]
        }
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });
    const l2 = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "P6-EXP-2", brokerName: "Packet Broker", status: "draft", originAddress: "Austin, TX", destinationAddress: "El Paso, TX", loadedMiles: 575, quotedRevenue: 1500 }
    });
    const l3 = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "P6-EXP-3", brokerName: "Packet Broker", status: "draft", originAddress: "Tyler, TX", destinationAddress: "Lubbock, TX", loadedMiles: 400, quotedRevenue: 1200 }
    });

    await invoiceLoad(
      l1.id,
      { form: { number: "INV-PKT-1", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } },
      NOW,
      W
    );
    const parentInv = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "INV-PKT-1" } });
    const supp = await issueSupplemental(parentInv.id, [{ kind: "lumper", amount: 85, loadId: l1.id }], { reason: "Lumper receipt arrived" }, NOW, W);
    expect(supp.ok).toBe(true);
    if (!supp.ok) return;

    const bytes = await blankPdfBytes(1);
    const pdfType = { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" as const };
    const putDoc = async (kind: string, name: string, stopId: string | null = null) => {
      const saved = await addLoadDocument(l1.id, kind, { ok: true, name, type: pdfType, data: new Uint8Array(bytes) }, NOW, W, "Admin", stopId);
      if (!saved.ok) throw new Error(saved.error);
    };

    await putDoc("rate_con", "rc.pdf");
    await putDoc("pod", "pod-stop2.pdf", l1.stops[1]!.id);
    // Stop 3 delivery lacks POD -> packet should refuse citing proof of delivery.
    const incompletePkt = await buildPacket(l1.id, W, null);
    expect(incompletePkt).toMatchObject({ ok: false, error: expect.stringMatching(/proof of delivery/i) });

    // Upload POD for stop 3 and lumper receipt -> primary & supplemental packets succeed and include lumper.
    await putDoc("pod", "pod-stop3.pdf", l1.stops[2]!.id);
    await putDoc("lumper", "lumper.pdf");
    const fullPkt = await buildPacket(l1.id, W, null);
    expect(fullPkt.ok).toBe(true);
    if (!fullPkt.ok) return;
    expect(fullPkt.included.some((s) => s.includes("lumper.pdf"))).toBe(true);
    expect(fullPkt.pages).toBeGreaterThanOrEqual(5);

    const suppPkt = await buildPacket(l1.id, W, null, { invoiceId: supp.id });
    expect(suppPkt.ok).toBe(true);
    if (!suppPkt.ok) return;
    expect(suppPkt.filename).toContain("-S1");
    expect(suppPkt.included.some((s) => s.includes("lumper.pdf"))).toBe(true);

    // Board multi-select CSV export filters strictly by selected ids (verified on demo-workspace & cleaned up).
    const demoExp = await Promise.all([
      prisma.load.create({ data: { workspaceId: "demo-workspace", loadNumber: "P6-EXP-A", brokerName: "Export Co", status: "draft", originAddress: "Dallas, TX", destinationAddress: "Houston, TX", loadedMiles: 240, quotedRevenue: 900 } }),
      prisma.load.create({ data: { workspaceId: "demo-workspace", loadNumber: "P6-EXP-B", brokerName: "Export Co", status: "draft", originAddress: "Austin, TX", destinationAddress: "San Antonio, TX", loadedMiles: 80, quotedRevenue: 450 } }),
      prisma.load.create({ data: { workspaceId: "demo-workspace", loadNumber: "P6-EXP-C", brokerName: "Export Co", status: "draft", originAddress: "El Paso, TX", destinationAddress: "Lubbock, TX", loadedMiles: 350, quotedRevenue: 1100 } })
    ]);
    try {
      const exp = await buildExport("loads", { ids: `${demoExp[0].id},${demoExp[1].id}` }, NOW);
      expect(exp).not.toBeNull();
      expect(exp!.csv).toContain("P6-EXP-A");
      expect(exp!.csv).toContain("P6-EXP-B");
      expect(exp!.csv).not.toContain("P6-EXP-C");
    } finally {
      await prisma.load.deleteMany({ where: { id: { in: demoExp.map((x) => x.id) } } });
    }
    expect(l2.loadNumber).toBe("P6-EXP-2");
    expect(l3.loadNumber).toBe("P6-EXP-3");
  });
});
