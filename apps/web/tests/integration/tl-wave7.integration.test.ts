import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toEditValues, type LoadEditValues } from "@/lib/load-edit";
import { historyRows } from "@/lib/loads-history";
import { toCentralLocal } from "@/lib/zoned";
import { assignDriver, dispatchLoad, recordDriverResponse } from "@/server/tl/dispatch";
import { saveLoadDetails } from "@/server/tl/edit";
import { completeTrip, saveExpenses, startTrip } from "@/server/tl/execution";
import { saveDriver, saveTruck } from "@/server/tl/fleet";
import { getInvoice, invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { listBoardRows, listInvoiceRows } from "@/server/tl/queries";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own truck, driver and loads (all named W7) and removes them and
 * their audit events afterwards, so the demo data is left as the seed wrote it. Every window is in 2027, so nothing seeded is on the road then.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;

describe.skipIf(!run)("loads and billing on the demo database", () => {
  const startedAt = new Date();
  let truckId = "";
  let driverId = "";

  const day = (d: string, hour: number) => new Date(`${d}T${String(hour).padStart(2, "0")}:00:00Z`);
  const mkLoad = (n: string, d: string, over: Record<string, unknown> = {}) =>
    prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `W7-${n}`,
        brokerName: "W7 Broker",
        status: "draft",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 1000,
        scheduledDate: day(d, 14),
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: day(d, 14), timeWindowLatest: day(d, 16), referenceNumbers: [`PU-${n}`] },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: day(d, 22), timeWindowLatest: day(d, 23), referenceNumbers: [`DL-${n}`] }
          ]
        },
        ...over
      }
    });
  const valuesOf = async (id: string): Promise<LoadEditValues> => toEditValues(await prisma.load.findUniqueOrThrow({ where: { id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
  const events = (loadId: string) => prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "asc" } });
  /** A load with the driver on it who has said yes. */
  const accepted = async (n: string, d: string) => {
    const l = await mkLoad(n, d);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
    await dispatchLoad(l.id);
    await recordDriverResponse(l.id, "accepted");
    return l;
  };

  beforeAll(async () => {
    const t = await saveTruck({ name: "W7 Truck", type: "box_truck", mpg: "9", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    const d = await saveDriver({ name: "W7 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckId, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ loadNumber: { startsWith: "W7-" } }, { brokerName: "W7 Broker" }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W7" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W7" } } });
  });

  test("a truck keeps its make, model, year and specs; the same numbers typed again are not a change", async () => {
    const spec = { name: "W7 Truck", type: "box_truck", mpg: "6.8", fuelType: "diesel", make: "Hackney", model: "Step Van", year: "1999", payloadLbs: "6,000", maxLengthFt: "14", maxWidthFt: "7", maxHeightIn: "84" };
    expect(await saveTruck(spec, truckId)).toMatchObject({ ok: true, changed: true });
    const row = await prisma.vehicle.findUniqueOrThrow({ where: { id: truckId } });
    expect(row).toMatchObject({ make: "Hackney", model: "Step Van", year: 1999, payloadLbs: 6000 });
    expect([Number(row.maxLengthFt), Number(row.maxWidthFt), Number(row.maxHeightIn)]).toEqual([14, 7, 84]);

    expect(await saveTruck({ ...spec, mpg: "6.80", maxLengthFt: "14.0" }, truckId)).toMatchObject({ ok: true, changed: false });
    expect(await saveTruck({ ...spec, payloadLbs: "6500" }, truckId)).toMatchObject({ ok: true, changed: true });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entity: "fleet", action: "truck_changed", summary: { contains: "W7 Truck" } }, orderBy: { createdAt: "desc" } });
    expect(ev.before).toMatchObject({ "Payload (lb)": "6000" });
    expect(ev.after).toMatchObject({ "Payload (lb)": "6500", Make: "Hackney", Model: "Step Van", Year: "1999" });

    const bad = await saveTruck({ name: "W7 Bad", year: "1900", maxWidthFt: "30" }, null);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors ?? {}).sort()).toEqual(["maxWidthFt", "year"]);
    expect((await listBoardRows()).length).toBeGreaterThan(0);
  });

  test("editing an open load changes the load and its stops, derives the lane and the first pickup, and writes one audit entry listing what changed", async () => {
    const load = await mkLoad("EDIT", "2027-03-02");
    const v = await valuesOf(load.id);
    v.brokerEmail = "ap@w7.example";
    v.weightLbs = "12000";
    v.ramp = true;
    v.stops[0]!.refs = "PU-1, PU-2";
    v.stops[0]!.earliest = "2027-03-02T09:00";
    v.stops[0]!.latest = "2027-03-02T11:00";
    v.stops[1]!.address = "Memphis, TN";
    v.stops[1]!.earliest = "2027-03-03T09:00";
    v.stops[1]!.latest = "2027-03-03T11:00";
    expect(await saveLoadDetails(load.id, v)).toMatchObject({ ok: true, changed: true, note: null });

    const after = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(after).toMatchObject({ brokerEmail: "ap@w7.example", weightLbs: 12000, requiresRamp: true });
    expect(after.pickupNumbers).toEqual(["PU-1", "PU-2"]);
    expect(after.destinationAddress).toContain("Memphis");
    expect(after.scheduledDate!.toISOString()).toBe("2027-03-02T15:00:00.000Z"); // 9:00 in Dallas before daylight time starts
    expect(after.stops[1]!.addressString).toBe("Memphis, TN");

    const [edited] = (await events(load.id)).filter((e) => e.action === "load_edited");
    expect(edited!.summary).toMatch(/^Details changed:/);
    expect(Object.keys(edited!.after as object)).toEqual(expect.arrayContaining(["Customer email", "Weight (lb)", "Ramp needed", "Stop 1 references", "Stop 2 address"]));
    expect(Object.keys(edited!.after as object)).not.toContain("Customer");

    const again = await saveLoadDetails(load.id, await valuesOf(load.id));
    expect(again).toMatchObject({ ok: true, changed: false });
    expect((await events(load.id)).filter((e) => e.action === "load_edited")).toHaveLength(1);
  });

  test("a cancelled load, a stale form and a quote cannot be edited; a load on the road keeps its stops but takes corrections", async () => {
    const cancelled = await mkLoad("CANCELLED", "2027-03-06", { status: "cancelled" });
    const cv = await valuesOf(cancelled.id);
    cv.notes = "x";
    expect(await saveLoadDetails(cancelled.id, cv)).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) });

    const quote = await mkLoad("QUOTE", "2027-03-07", { status: "quote" });
    expect(await saveLoadDetails(quote.id, await valuesOf(quote.id))).toMatchObject({ ok: false });

    const open = await mkLoad("OPEN", "2027-03-08");
    const stale = await valuesOf(open.id);
    stale.stops.pop();
    expect(await saveLoadDetails(open.id, stale)).toMatchObject({ ok: false, error: expect.stringMatching(/changed since you opened/) });
    const bad = await valuesOf(open.id);
    bad.brokerEmail = "nope";
    const refused = await saveLoadDetails(open.id, bad);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toHaveProperty("brokerEmail");

    const road = await mkLoad("ROAD", "2027-03-09", { status: "in_progress" });
    const moved = await valuesOf(road.id);
    moved.stops[0]!.earliest = "2027-03-09T10:00";
    expect(await saveLoadDetails(road.id, moved)).toMatchObject({ ok: false, error: expect.stringMatching(/has started/) });
    const fixed = await valuesOf(road.id);
    fixed.poNumber = "PO-FIXED";
    fixed.notes = "Dock is round the back";
    expect(await saveLoadDetails(road.id, fixed)).toMatchObject({ ok: true, changed: true });
    expect(await prisma.load.findUniqueOrThrow({ where: { id: road.id } })).toMatchObject({ poNumber: "PO-FIXED", notes: "Dock is round the back" });
  });

  test("moving a stop the driver already accepted asks them again; a move that puts them on two loads at once is refused", async () => {
    const a = await accepted("CLASH-A", "2027-04-01");
    const b = await accepted("CLASH-B", "2027-04-10");

    const onto = await valuesOf(b.id);
    onto.stops[0]!.earliest = "2027-04-01T09:00";
    onto.stops[0]!.latest = "2027-04-01T11:00";
    onto.stops[1]!.earliest = "2027-04-01T16:00";
    onto.stops[1]!.latest = "2027-04-01T17:00";
    const refused = await saveLoadDetails(b.id, onto);
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.error).toContain(a.loadNumber);

    const before = await prisma.assignment.findUniqueOrThrow({ where: { loadId: b.id } });
    const next = await valuesOf(b.id);
    next.stops[0]!.earliest = "2027-04-11T09:00";
    next.stops[0]!.latest = "2027-04-11T11:00";
    next.stops[1]!.earliest = "2027-04-11T16:00";
    next.stops[1]!.latest = "2027-04-11T17:00";
    const out = await saveLoadDetails(b.id, next);
    expect(out).toMatchObject({ ok: true, changed: true, note: expect.stringContaining("W7 Driver") });
    const now = await prisma.assignment.findUniqueOrThrow({ where: { loadId: b.id } });
    expect(now.status).toBe("dispatched");
    expect(now.respondedAt).toBeNull();
    expect(now.assignmentVersion).toBe(before.assignmentVersion + 1);
    expect((await events(b.id)).find((e) => e.action === "load_edited")!.summary).toContain("confirm again");
  });

  test("the desk enters a trip for the driver: pickup, then delivery with proof of delivery and expenses, then expenses on their own; every step is audited", async () => {
    const draft = await mkLoad("TRIP-DRAFT", "2027-05-03");
    expect(await startTrip(draft.id, { arrivedAt: toCentralLocal(Date.now() - 5 * H), waitMinutes: "", seal: "" })).toMatchObject({ ok: false });

    const load = await accepted("TRIP", "2027-05-01");
    const bad = await startTrip(load.id, { arrivedAt: toCentralLocal(Date.now() + 5 * H), waitMinutes: "9999", seal: "" });
    expect(bad).toMatchObject({ ok: false, errors: { arrivedAt: expect.any(String), waitMinutes: expect.any(String) } });

    expect(await startTrip(load.id, { arrivedAt: toCentralLocal(Date.now() - 5 * H), waitMinutes: "30", seal: "SEAL-7" })).toEqual({ ok: true });
    const started = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: true } });
    expect(started.status).toBe("in_progress");
    expect(started.assignment!.status).toBe("in_progress");
    expect(started.stops[0]).toMatchObject({ waitMinutes: 30, sealNumber: "SEAL-7" });
    expect(started.stops[0]!.arrivedAt).not.toBeNull();
    expect(await startTrip(load.id, { arrivedAt: toCentralLocal(Date.now() - 4 * H), waitMinutes: "", seal: "" })).toMatchObject({ ok: false });

    const stopId = started.stops[1]!.id;
    const done = { stops: [{ id: stopId, arrivedAt: toCentralLocal(Date.now() - 2 * H), waitMinutes: "20" }], deliveredAt: toCentralLocal(Date.now() - H), pod: "received" as const, podNote: "Signed BOL emailed", fuel: "100.50", tolls: "", misc: "" };
    const noWhy = await completeTrip(load.id, { ...done, pod: "none", podNote: "" });
    expect(noWhy).toMatchObject({ ok: false, errors: { podNote: expect.any(String) } });
    const early = await completeTrip(load.id, { ...done, deliveredAt: toCentralLocal(Date.now() - 6 * H) });
    expect(early).toMatchObject({ ok: false, errors: { deliveredAt: expect.stringMatching(/before the pickup/) } });
    expect(await completeTrip(load.id, done)).toEqual({ ok: true });

    const finished = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { assignment: true } });
    expect(finished).toMatchObject({ status: "completed", dockWaitMinutes: 50, closedWithoutPod: false, podNote: "Signed BOL emailed" });
    expect(Number(finished.actualRevenue)).toBe(1000);
    expect(Number(finished.expenseFuelActual)).toBe(100.5);
    expect(finished.assignment!.status).toBe("completed");
    expect(await completeTrip(load.id, done)).toMatchObject({ ok: false, error: expect.stringMatching(/already delivered/) });

    expect(await saveExpenses(load.id, { fuel: "100.50", tolls: "12", misc: "" })).toEqual({ ok: true, changed: true });
    expect(await saveExpenses(load.id, { fuel: "100.5", tolls: "12.00", misc: "0" })).toEqual({ ok: true, changed: false });
    expect(await saveExpenses(draft.id, { fuel: "1", tolls: "", misc: "" })).toMatchObject({ ok: false });

    const actions = (await events(load.id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["trip_started", "delivered", "expenses_changed"]));
    expect((await events(load.id)).find((e) => e.action === "trip_started")!.summary).toContain("entered by the desk");
  });

  test("a delivered load is invoiced with its extra charges, refuses a number already used, and cannot be invoiced twice", async () => {
    const load = await prisma.load.findFirstOrThrow({ where: { loadNumber: "W7-TRIP" } });
    const form = { number: "W7-INV-1", terms: "45", detention: false, lumper: "40", layover: "", otherLabel: "", other: "" };
    const out = await invoiceLoad(load.id, { form });
    expect(out).toMatchObject({ ok: true, total: 1040 });
    const row = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(row).toMatchObject({ paymentStatus: "invoiced", invoiceNumber: "W7-INV-1", payTermsDays: 45 });
    expect(Number(row.invoicedAmount)).toBe(1040);
    expect(row.invoiceLines).toEqual([
      { label: "Line haul", amount: 1000 },
      { label: "Lumper", amount: 40 }
    ]);
    const ev = (await events(load.id)).find((e) => e.action === "invoiced")!;
    expect(ev.summary).toContain("W7-INV-1");
    expect(ev.summary).toContain("lumper");

    expect(await invoiceLoad(load.id, { form })).toMatchObject({ ok: false });

    const other = await mkLoad("INV-2", "2027-06-01", { status: "completed", completedAt: new Date() });
    const dupe = await invoiceLoad(other.id, { form });
    expect(dupe).toMatchObject({ ok: false, errors: { number: expect.stringContaining("W7-TRIP") } });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: other.id } })).paymentStatus).toBeNull();

    const bad = await invoiceLoad(other.id, { form: { ...form, number: "", terms: "500", lumper: "-1" } });
    expect(bad).toMatchObject({ ok: false });
    expect(Object.keys(bad.errors ?? {}).sort()).toEqual(["lumper", "number", "terms"]);
  });

  test("a load with nobody to bill, or no number, is not invoiced", async () => {
    const noBroker = await mkLoad("NOBILL", "2027-06-02", { status: "completed", completedAt: new Date(), brokerName: null });
    expect(await invoiceLoad(noBroker.id, {})).toMatchObject({ ok: false, error: expect.stringMatching(/billed to/) });
    const noNumber = await mkLoad("NONUM", "2027-06-03", { status: "completed", completedAt: new Date(), loadNumber: null });
    expect(await invoiceLoad(noNumber.id, {})).toMatchObject({ ok: false, error: expect.stringMatching(/load number/) });
    const undelivered = await mkLoad("UNDELIVERED", "2027-06-04");
    expect(await invoiceLoad(undelivered.id, {})).toMatchObject({ ok: false });
    for (const l of [noBroker, noNumber, undelivered]) expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).paymentStatus).toBeNull();
  });

  test("a short payment is recorded as it came and says by how much; it can be taken back with a reason", async () => {
    const load = await prisma.load.findFirstOrThrow({ where: { loadNumber: "W7-TRIP" } });
    expect(await markLoadPaid(load.id, new Date(), { amount: 0 })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await markLoadPaid(load.id, new Date(), { amount: 1000 })).toEqual({ ok: true, difference: -40 });
    const paid = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(paid.paymentStatus).toBe("paid");
    expect(Number(paid.paidAmount)).toBe(1000);
    expect((await events(load.id)).find((e) => e.action === "paid")!.summary).toContain("$40.00 short");
    expect(await markLoadPaid(load.id)).toMatchObject({ ok: false });

    const invoice = await getInvoice(load.id);
    expect(invoice).toMatchObject({ invoiceNumber: "W7-INV-1", total: 1040, status: "paid", paidAmount: 1000, terms: 45, billTo: { name: "W7 Broker" } });
    expect(invoice!.lines.map((l) => l.label)).toEqual(["Line haul", "Lumper"]);
    expect(invoice!.due.getTime() - invoice!.sent.getTime()).toBe(45 * 86_400_000);

    expect(await undoPaid(load.id, "x")).toMatchObject({ ok: false });
    expect(await undoPaid(load.id, "Entered against the wrong invoice")).toEqual({ ok: true });
    const back = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(back).toMatchObject({ paymentStatus: "invoiced", paidAt: null, paidAmount: null });
    expect((await events(load.id)).find((e) => e.action === "payment_undone")).toMatchObject({ reason: "Entered against the wrong invoice" });
    expect(await undoPaid(load.id, "Again, for no reason")).toMatchObject({ ok: false });

    expect(await markLoadPaid(load.id)).toEqual({ ok: true });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).paidAmount)).toBe(1040);
    expect(await getInvoice("does-not-exist")).toBeNull();
  });

  test("the board and the invoice list carry what the Loads and Invoices screens now need", async () => {
    const rows = await listBoardRows(undefined, "all"); // the board itself is the open loads; finished ones are History's
    const mine = rows.find((r) => r.loadNumber === "W7-TRIP")!;
    expect(mine).toMatchObject({ status: "completed", paymentStatus: "paid", invoiceNumber: "W7-INV-1", invoicedAmount: 1040, paidAmount: 1040 });
    expect(mine.completedAt).not.toBeNull();
    const history = historyRows(rows, { q: "w7-inv-1" });
    expect(history.map((r) => r.loadNumber)).toEqual(["W7-TRIP"]);
    expect(historyRows(rows, { filter: "owed" }).every((r) => r.status === "completed" && r.paymentStatus !== "paid")).toBe(true);
    expect(historyRows(rows, { filter: "cancelled" }).some((r) => r.loadNumber === "W7-CANCELLED")).toBe(true);
    expect(rows.filter((r) => r.loadNumber === "W7-QUOTE")).toHaveLength(0); // a quote is not a load

    const invoices = await listInvoiceRows();
    const ready = invoices.find((r) => r.loadNumber === "W7-INV-2")!;
    expect(ready).toMatchObject({ status: null, defaultNumber: "INV-W7-INV-2" });
    expect(ready.invoiceContext).toMatchObject({ rate: 1000, surcharge: 0 });
    expect(ready.readiness.blockers).toEqual([]);
    const noBroker = invoices.find((r) => r.loadNumber === "W7-NOBILL")!;
    expect(noBroker.readiness.blockers.join(" ")).toMatch(/billed to/);
    const sent = invoices.find((r) => r.loadNumber === "W7-TRIP")!;
    expect(sent).toMatchObject({ status: "paid", paidDifference: 0 });
  });
});
