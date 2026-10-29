import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toEditValues, type LoadEditValues } from "@/lib/load-edit";
import { saveCompany, getCompany } from "@/server/tl/company";
import { assignDriver, dispatchLoad, recordDriverResponse } from "@/server/tl/dispatch";
import { saveLoadDetails } from "@/server/tl/edit";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { getInvoice, invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { getLoadDetail, listBoardRows } from "@/server/tl/queries";
import { deleteLoad, restoreLoad } from "@/server/tl/remove";
import { finalizeSettlement, startSettlement } from "@/server/tl/settlement";
import { DuplicateLoadError, saveReviewedDraft, type ReviewedDraft } from "@/server/ratecon/save";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own trucks, driver and loads (all named WC0) and removes them,
 * their statements and their audit events afterwards. Dallas is on daylight time (UTC-5) until 1 November 2026.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const at = (local: string) => new Date(`${local}:00-05:00`);

const profile = (insurance: string): Record<string, string> => ({
  monthlyInsurance: insurance,
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "3.9",
  driverHourlyTarget: "25",
  archetype: "solo_owner"
});

describe.skipIf(!run)("core load integrity on the demo database", () => {
  const startedAt = new Date();
  let truckA = "";
  let truckB = "";
  let bareTruck = "";
  let driverId = "";
  const originalCompany = { current: null as Awaited<ReturnType<typeof getCompany>> | null };

  // Each load that gets a driver has its own day, so the double-booking guard never gets in the way.
  const mkLoad = (n: string, over: Record<string, unknown> = {}, day = "2027-04-05") =>
    prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `WC0-${n}`,
        brokerName: "WC0 Broker",
        vehicleId: truckA,
        status: "accepted",
        quotedRevenue: 1000,
        fuelSurcharge: 100,
        loadedMiles: 200,
        pickupDeadheadMiles: 20,
        returnDeadheadMiles: 30,
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        scheduledDate: at(`${day}T08:00`),
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: at(`${day}T08:00`), timeWindowLatest: at(`${day}T09:00`) },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: at(`${day}T16:00`), timeWindowLatest: at(`${day}T17:00`) }
          ]
        },
        ...over
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });
  const valuesOf = async (id: string): Promise<LoadEditValues> => toEditValues(await prisma.load.findUniqueOrThrow({ where: { id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
  const withDeal = (v: LoadEditValues, patch: Partial<NonNullable<LoadEditValues["deal"]>>): LoadEditValues => ({ ...v, deal: { ...v.deal!, ...patch } });
  const events = (loadId: string) => prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    originalCompany.current = await getCompany();
    const a = await saveTruck({ name: "WC0 Truck A", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const b = await saveTruck({ name: "WC0 Truck B", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const bare = await saveTruck({ name: "WC0 Bare", type: "pickup" }, null);
    if (!a.ok || !b.ok || !bare.ok) throw new Error("trucks");
    truckA = a.id;
    truckB = b.id;
    bareTruck = bare.id;
    if (!(await saveCostProfile(truckA, profile("800"))).ok || !(await saveCostProfile(truckB, profile("2400"))).ok) throw new Error("profiles");
    const d = await saveDriver({ name: "WC0 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckA, payKind: "percent", payRate: "25" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ loadNumber: { startsWith: "WC0-" } }, { brokerName: "WC0 Broker" }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.settlementLoad.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { driver: { name: { startsWith: "WC0" } } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: { in: ["fleet", "settlement", "settings"] } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC0" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC0" } } });
    const c = originalCompany.current;
    if (c) await prisma.workspace.update({ where: { id: WS }, data: c });
  });

  test("the rate, surcharge and miles can be corrected: the driver's percent pay follows and they are asked to confirm, stale drive hours go, and the audit says what changed", async () => {
    const load = await mkLoad("EDIT", { estimatedLoadedHours: 4 });
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "percent", rate: 25 } });
    await dispatchLoad(load.id);
    await recordDriverResponse(load.id, "accepted");
    const before = await prisma.assignment.findUniqueOrThrow({ where: { loadId: load.id } });
    expect(before.status).toBe("accepted");
    expect(num(before.payEstimate)).toBe(275); // 25% of 1,100

    const v = await valuesOf(load.id);
    const out = await saveLoadDetails(load.id, withDeal(v, { rate: "1200", loadedMiles: "250" }));
    expect(out).toMatchObject({ ok: true, changed: true, note: expect.stringContaining("what it pays now") });
    const row = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { assignment: true } });
    expect(num(row.quotedRevenue)).toBe(1200);
    expect(num(row.loadedMiles)).toBe(250);
    expect(row.estimatedLoadedHours).toBeNull(); // measured for 200 miles, not 250
    expect(num(row.assignment!.payEstimate)).toBe(325); // 25% of 1,300
    expect(row.assignment!.status).toBe("dispatched"); // asked to confirm again
    expect(row.assignment!.assignmentVersion).toBeGreaterThan(before.assignmentVersion);
    const ev = (await events(load.id)).filter((e) => e.action === "load_edited").pop()!;
    expect(ev.after).toMatchObject({ Rate: "$1200.00", "Loaded miles": "250" });
    expect(ev.before).toMatchObject({ Rate: "$1000.00", "Loaded miles": "200" });

    // Saving the same figures again changes nothing.
    expect(await saveLoadDetails(load.id, await valuesOf(load.id))).toMatchObject({ ok: true, changed: false });
  });

  test("moving a load to another truck refreezes the cost floor it was booked with; a truck with no cost profile, and a bad figure, are refused", async () => {
    const load = await mkLoad("MOVE", {}, "2027-04-12");
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "cpm", rate: 0.5 } });
    const was = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(was.snapshotBaseFloorRpm).not.toBeNull();

    const v = await valuesOf(load.id);
    expect(await saveLoadDetails(load.id, withDeal(v, { vehicleId: bareTruck }))).toMatchObject({ ok: false, error: expect.stringContaining("no cost profile") });
    expect(await saveLoadDetails(load.id, withDeal(v, { vehicleId: "" }))).toMatchObject({ ok: false, error: expect.stringContaining("Pick the truck") });
    expect(await saveLoadDetails(load.id, withDeal(v, { rate: "-5" }))).toMatchObject({ ok: false, errors: { "deal.rate": expect.any(String) } });
    expect(await saveLoadDetails(load.id, withDeal(v, { loadedMiles: "9000" }))).toMatchObject({ ok: false, errors: { "deal.loadedMiles": expect.any(String) } });

    expect(await saveLoadDetails(load.id, withDeal(v, { vehicleId: truckB }))).toMatchObject({ ok: true, changed: true });
    const now = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(now.vehicleId).toBe(truckB);
    expect(num(now.snapshotBaseFloorRpm)).toBeGreaterThan(num(was.snapshotBaseFloorRpm)); // truck B carries more insurance
    expect((await events(load.id)).some((e) => JSON.stringify(e.after).includes("WC0 Truck B"))).toBe(true);
  });

  test("a load on the road keeps its truck but its rate can still be corrected; an invoiced load keeps both", async () => {
    const onRoad = await mkLoad("ROAD", { status: "in_progress" });
    const v = await valuesOf(onRoad.id);
    expect(await saveLoadDetails(onRoad.id, withDeal(v, { vehicleId: truckB }))).toMatchObject({ ok: false, error: expect.stringContaining("keeps its truck") });
    expect(await saveLoadDetails(onRoad.id, withDeal(v, { rate: "1100" }))).toMatchObject({ ok: true, changed: true });

    const billed = await mkLoad("BILLED", { status: "completed", completedAt: at("2027-04-06T10:00"), paymentStatus: "invoiced", invoiceNumber: "WC0-INV-LOCK", invoicedAmount: 1100, invoicedAt: new Date() });
    const bv = await valuesOf(billed.id);
    expect(await saveLoadDetails(billed.id, withDeal(bv, { rate: "1300" }))).toMatchObject({ ok: false, error: expect.stringContaining("invoiced") });
    // Its details (not the money) can still be corrected.
    expect(await saveLoadDetails(billed.id, { ...bv, poNumber: "PO-FIXED" })).toMatchObject({ ok: true, changed: true });
  });

  test("seconds on a stored stop time are not a schedule change: a started load can still be corrected, and a driver is not asked to confirm again for a rate that does not move their pay", async () => {
    const load = await mkLoad("SECS", { fuelSurcharge: 90 }, "2027-04-20");
    for (const [i, s] of load.stops.entries()) await prisma.stop.update({ where: { id: s.id }, data: { timeWindowEarliest: new Date(s.timeWindowEarliest!.getTime() + 17_000 + i), timeWindowLatest: new Date(s.timeWindowLatest!.getTime() + 41_000) } });
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "cpm", rate: 0.5 } });
    await dispatchLoad(load.id);
    await recordDriverResponse(load.id, "accepted");
    const out = await saveLoadDetails(load.id, withDeal(await valuesOf(load.id), { rate: "1111" }));
    expect(out).toMatchObject({ ok: true, changed: true, note: null });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: load.id } })).status).toBe("accepted"); // cents-per-mile pay does not follow the rate

    await prisma.load.update({ where: { id: load.id }, data: { status: "in_progress" } });
    expect(await saveLoadDetails(load.id, { ...(await valuesOf(load.id)), poNumber: "PO-STARTED" })).toMatchObject({ ok: true, changed: true });
  });

  test("a load on a driver statement keeps its money, cannot be deleted, and the statement is the reason given", async () => {
    const paidOut = await mkLoad("STMT", {
      status: "completed",
      completedAt: at("2026-10-21T10:00"),
      assignment: { create: { driverId, payKind: "flat", payRate: 450, status: "completed" } }
    });
    const started = await startSettlement({ driverId, start: "2026-10-19", end: "2026-10-25" });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(await finalizeSettlement(started.id, { hours: {}, adjustments: [] })).toEqual({ ok: true, id: started.id });

    const v = await valuesOf(paidOut.id);
    expect(await saveLoadDetails(paidOut.id, withDeal(v, { rate: "2000" }))).toMatchObject({ ok: false, error: expect.stringContaining("driver statement") });
    expect(await deleteLoad({ loadId: paidOut.id, reason: "mistake" })).toMatchObject({ ok: false, error: expect.stringContaining("driver statement") });
  });

  test("a deleted load leaves the board, the detail page and the driver's calendar, keeps its audit, and Undo puts it back exactly as it was", async () => {
    const load = await mkLoad("DEL", {}, "2027-04-14");
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "cpm", rate: 0.5 } });
    expect(await deleteLoad({ loadId: load.id, reason: "nope" })).toMatchObject({ ok: false, error: expect.stringContaining("Pick a reason") });
    expect(await deleteLoad({ loadId: load.id, reason: "other", note: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("reason is Other") });

    expect(await deleteLoad({ loadId: load.id, reason: "duplicate" })).toEqual({ ok: true });
    expect(await getLoadDetail(load.id)).toBeNull();
    expect((await listBoardRows()).some((r) => r.id === load.id)).toBe(false);
    expect(await deleteLoad({ loadId: load.id, reason: "duplicate" })).toMatchObject({ ok: false }); // already gone
    const gone = (await events(load.id)).find((e) => e.action === "deleted")!;
    expect(gone.summary).toContain("Duplicate of another load");

    expect(await restoreLoad(load.id)).toEqual({ ok: true });
    const back = await getLoadDetail(load.id);
    expect(back?.load.assignment?.driverId).toBe(driverId); // the assignment was never removed
    expect((await listBoardRows()).some((r) => r.id === load.id)).toBe(true);
    expect((await events(load.id)).some((e) => e.action === "restored")).toBe(true);
    expect(await restoreLoad(load.id)).toMatchObject({ ok: false });
  });

  test("a load on the road or an invoiced one cannot be deleted", async () => {
    const onRoad = await mkLoad("DELROAD", { status: "in_progress" });
    expect(await deleteLoad({ loadId: onRoad.id, reason: "mistake" })).toMatchObject({ ok: false, error: expect.stringContaining("on the road") });
    const billed = await mkLoad("DELBILLED", { status: "completed", completedAt: at("2027-04-06T10:00"), paymentStatus: "invoiced", invoiceNumber: "WC0-INV-DEL", invoicedAmount: 1100, invoicedAt: new Date() });
    expect(await deleteLoad({ loadId: billed.id, reason: "mistake" })).toMatchObject({ ok: false, error: expect.stringContaining("invoiced") });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: billed.id } })).deletedAt).toBeNull();
  });

  describe("a rate confirmation saved as a load", () => {
    const draft = (over: Partial<ReviewedDraft["load"]> = {}): ReviewedDraft => ({
      load: { brokerName: "WC0 Broker", brokerMcNumber: "123456", loadNumber: "WC0-RC-1", poNumber: null, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", trailerType: "dry_van", quotedRevenue: 1300, loadedMiles: 452.6, payTermsDays: 30, paymentTerms: "Net 30", stopsCount: 2, pickupNumbers: [], deliveryNumbers: [], channel: "rate_con", status: "draft", ...over },
      stops: [
        { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: null, timeWindowEarliest: at("2027-05-03T08:00"), timeWindowLatest: at("2027-05-03T09:00"), referenceNumbers: [], contactPhone: null, stopNotes: null },
        { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", facilityName: null, timeWindowEarliest: at("2027-05-03T16:00"), timeWindowLatest: at("2027-05-03T17:00"), referenceNumbers: [], contactPhone: null, stopNotes: null }
      ],
      printed: { commodity: "Paper", weightLbs: 41000, fuelSurchargeIncluded: null, dockTerms: "Two hours free, then $50 an hour", detentionFreeMinutes: 120, detentionHourlyRate: 50, notes: "Call ahead", tonuOnly: false },
      warnings: [],
      confirmed: true,
      fileName: "rate-con-wc0.pdf"
    });

    test("keeps the weight, the notes and dock terms, the file name, decimal miles and the document's detention terms, and refuses a second load with the same number", async () => {
      const saved = await saveReviewedDraft(draft());
      const row = await prisma.load.findUniqueOrThrow({ where: { id: saved.id } });
      expect(row).toMatchObject({ weightLbs: 41000, rateConPath: "rate-con-wc0.pdf", snapshotFreeGraceMinutes: 120 });
      expect(num(row.loadedMiles)).toBe(452.6);
      expect(num(row.snapshotDetentionRate)).toBe(50);
      expect(row.notes).toBe("Call ahead\nDock terms: Two hours free, then $50 an hour");

      const twice = await saveReviewedDraft(draft()).catch((e) => e);
      expect(twice).toBeInstanceOf(DuplicateLoadError);
      expect((twice as DuplicateLoadError).loadId).toBe(saved.id);
      // The same number from another named broker is another load; the same broker saves when asked to.
      expect(await saveReviewedDraft(draft({ brokerName: "WC0 Other Broker" })).then((l) => l.id)).not.toBe(saved.id);
      const again = await saveReviewedDraft({ ...draft(), allowDuplicate: true });
      expect(again.id).not.toBe(saved.id);
    });

    test("a deleted load's number is free to use again", async () => {
      const first = await saveReviewedDraft(draft({ loadNumber: "WC0-RC-2" }));
      expect(await deleteLoad({ loadId: first.id, reason: "mistake" })).toEqual({ ok: true });
      await expect(saveReviewedDraft(draft({ loadNumber: "WC0-RC-2" }))).resolves.toMatchObject({ id: expect.any(String) });
    });
  });

  describe("the company, invoice numbers and payments", () => {
    test("the company details are checked, saved with an audit entry listing only what changed, and printed on the invoice", async () => {
      expect(await saveCompany({ name: "", mcNumber: "12", dotNumber: "", address: "", phone: "", email: "nope", remitTo: "", paymentNote: "" })).toMatchObject({ ok: false, errors: { name: expect.any(String), mcNumber: expect.any(String), email: expect.any(String) } });
      const out = await saveCompany({ name: "WC0 Freight LLC", mcNumber: "MC 998877", dotNumber: "4455667", address: "1 Main St\nDallas, TX 75201", phone: "555-0142", email: "billing@wc0.example", remitTo: "WC0 Freight, PO Box 1, Dallas TX", paymentNote: "Net 30" });
      expect(out).toMatchObject({ ok: true, changed: true });
      expect((await getCompany()).mcNumber).toBe("998877");
      expect(await saveCompany({ name: "WC0 Freight LLC", mcNumber: "998877", dotNumber: "4455667", address: "1 Main St\nDallas, TX 75201", phone: "555-0142", email: "billing@wc0.example", remitTo: "WC0 Freight, PO Box 1, Dallas TX", paymentNote: "Net 30" })).toMatchObject({ ok: true, changed: false });
      const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: "company_changed", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
      expect(ev.after).toMatchObject({ "Company name": "WC0 Freight LLC", "MC number": "998877" });

      const load = await mkLoad("INVCO", { status: "completed", completedAt: at("2027-04-06T10:00") });
      expect(await invoiceLoad(load.id, { form: { number: "WC0-INV-CO", terms: "", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } })).toMatchObject({ ok: true });
      const inv = await getInvoice(load.id);
      expect(inv?.company).toMatchObject({ name: "WC0 Freight LLC", mcNumber: "998877", dotNumber: "4455667", remitTo: "WC0 Freight, PO Box 1, Dallas TX" });
      expect(inv?.issuer).toBe("WC0 Freight LLC");
    });

    test("two loads cannot share an invoice number: the form says so, and the database holds when two are saved at once", async () => {
      const a = await mkLoad("NUM-A", { status: "completed", completedAt: at("2027-04-06T10:00") });
      const b = await mkLoad("NUM-B", { status: "completed", completedAt: at("2027-04-06T11:00") });
      const form = { number: "WC0-INV-SAME", terms: "", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };
      expect(await invoiceLoad(a.id, { form })).toMatchObject({ ok: true });
      expect(await invoiceLoad(b.id, { form })).toMatchObject({ ok: false, errors: { number: expect.stringContaining("already on WC0-NUM-A") } });
      await expect(prisma.load.update({ where: { id: b.id }, data: { invoiceNumber: "WC0-INV-SAME" } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((await prisma.load.findUniqueOrThrow({ where: { id: b.id } })).invoiceNumber).toBeNull();
    });

    test("a payment is dated the day it came in and says how, never before the invoice or in the future, and taking it back clears both", async () => {
      const load = await mkLoad("PAYD", { status: "completed", completedAt: at("2026-10-01T10:00") });
      const form = { number: "WC0-INV-PAYD", terms: "", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };
      const invoicedOn = new Date("2026-10-05T15:00:00Z");
      expect(await invoiceLoad(load.id, { form }, invoicedOn)).toMatchObject({ ok: true });
      const now = new Date("2026-10-20T15:00:00Z");
      expect(await markLoadPaid(load.id, now, { paidOn: "2026-10-04" })).toMatchObject({ ok: false, error: expect.stringContaining("cannot be paid before") });
      expect(await markLoadPaid(load.id, now, { paidOn: "2026-10-21" })).toMatchObject({ ok: false, error: expect.stringContaining("has not happened") });
      expect(await markLoadPaid(load.id, now, { paidOn: "yesterday" })).toMatchObject({ ok: false, error: expect.stringContaining("day it was paid") });
      expect(await markLoadPaid(load.id, now, { method: "barter" })).toMatchObject({ ok: false, error: expect.stringContaining("how it was paid") });
      expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).paymentStatus).toBe("invoiced");

      expect(await markLoadPaid(load.id, now, { paidOn: "2026-10-10", method: "check" })).toEqual({ ok: true });
      const paid = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
      expect(paid.paidAt?.toISOString()).toBe("2026-10-10T17:00:00.000Z"); // noon in Dallas
      expect(paid.paidMethod).toBe("check");
      const ev = (await events(load.id)).find((e) => e.action === "paid")!;
      expect(ev.summary).toContain("by check on 2026-10-10");
      expect((await getInvoice(load.id))?.paidMethod).toBe("check");

      expect(await undoPaid(load.id, "Bounced")).toEqual({ ok: true });
      const out = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
      expect(out).toMatchObject({ paymentStatus: "invoiced", paidAt: null, paidMethod: null });
      // Paid today is stamped with the moment it was entered.
      expect(await markLoadPaid(load.id, now, {})).toEqual({ ok: true });
      expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).paidAt?.toISOString()).toBe(now.toISOString());
    });
  });
});
