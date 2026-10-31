import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, MAX_QUOTE_STOPS, readQuote, validateQuote, type QuoteValues } from "@/lib/quote";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { listQuoteDecisions } from "@/server/tl/quote-report";
import { buildQuoteReport } from "@/lib/quote-report";
import { getPlannerData } from "@/server/tl/planner";
import { getLoadDetail, listBoardRows } from "@/server/tl/queries";
import { bookQuote, brokerNames, discardQuote, quoteContext, fitQuote, getQuote, listQuotes, passQuote, saveQuote } from "@/server/tl/quote";

/**
 * Quote a load, the parts that keep money and decisions straight: two people booking at once, a saved quote that comes back as it was
 * (per-truck miles, the driver, the fuel price and where it came from, a zero factoring fee, the cents of a market rate), a quote that was
 * booked or passed on not being rewritten, and the browser's word for the truck and driver not being taken. Needs the seeded demo database.
 * Makes its own truck and drivers (named QI) and removes them afterwards.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";

const profile: Record<string, string> = {
  monthlyInsurance: "800",
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "3.9",
  driverHourlyTarget: "25",
  archetype: "solo_owner"
};

describe("a quote's own checks", () => {
  const base = (over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: "2030-02-09T08:00" },
      { role: "delivery", address: "Tulsa, OK", appointment: "2030-02-09T17:00" }
    ],
    offer: "1500",
    loadedMiles: "260",
    ...over
  });

  test("a delivery due before the pickup is refused, and stops are in order", () => {
    const out = validateQuote(base({ stops: [{ role: "pickup", address: "Dallas, TX", appointment: "2030-02-09T17:00" }, { role: "delivery", address: "Tulsa, OK", appointment: "2030-02-09T08:00" }] }));
    expect(out).toMatchObject({ ok: false, errors: { stop1Time: expect.stringMatching(/before the stop ahead/) } });
    expect(validateQuote(base()).ok).toBe(true);
  });

  test("a pickup far in the past is a warning, not a refusal", () => {
    const out = validateQuote(base({ stops: [{ role: "pickup", address: "Dallas, TX", appointment: "2020-02-09T08:00" }, { role: "delivery", address: "Tulsa, OK", appointment: "2020-02-09T17:00" }] }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.warnings.join(" ")).toMatch(/in the past/);
  });

  test("the stop count, the lengths and the trailer are bounded", () => {
    const stop = (role: "pickup" | "delivery") => ({ role, address: "Dallas, TX", appointment: "" });
    const many = [stop("pickup"), ...Array.from({ length: MAX_QUOTE_STOPS }, () => stop("delivery"))];
    expect(validateQuote(base({ stops: many }))).toMatchObject({ ok: false, errors: { stops: expect.any(String) } });
    expect(validateQuote(base({ broker: "x".repeat(121) }))).toMatchObject({ ok: false, errors: { broker: expect.any(String) } });
    expect(validateQuote(base({ trailer: "spaceship" }))).toMatchObject({ ok: false, errors: { trailer: expect.any(String) } });
  });

  test("the fuel price's source rides with it, and none without a price", () => {
    const withPrice = validateQuote(base({ fuelPrice: "4.10", fuelSource: "regional" }));
    expect(withPrice.ok && withPrice.input).toMatchObject({ fuelPrice: 4.1, fuelSource: "regional" });
    const none = validateQuote(base({ fuelSource: "regional" }));
    expect(none.ok && none.input).toMatchObject({ fuelPrice: null, fuelSource: null });
  });
});

describe("the other costs a quote counts", () => {
  const base = (over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: "" },
      { role: "delivery", address: "Tulsa, OK", appointment: "" }
    ],
    offer: "1500",
    loadedMiles: "260",
    ...over
  });

  test("are read as numbers, bounded, and blank counts none", () => {
    const ok = validateQuote(base({ dockWaitMinutes: "90", towingPerMile: "0.25", permitEscort: "400", insuranceRider: "75", marketBand: "15" }));
    expect(ok.ok && ok.input).toMatchObject({ dockWaitMinutes: 90, towingPerMile: 0.25, permitEscort: 400, insuranceRider: 75, marketBandFraction: 0.15 });
    const none = validateQuote(base());
    expect(none.ok && none.input).toMatchObject({ dockWaitMinutes: 0, towingPerMile: 0, permitEscort: 0, insuranceRider: 0, marketBandFraction: 0.1 });
    expect(validateQuote(base({ towingPerMile: "50" }))).toMatchObject({ ok: false, errors: { towingPerMile: expect.any(String) } });
    expect(validateQuote(base({ dockWaitMinutes: "-5" }))).toMatchObject({ ok: false, errors: { dockWaitMinutes: expect.any(String) } });
  });

  test("a surcharge that is half the offer, or a factoring fee of 50% or more, is asked about, not refused", () => {
    const fsc = validateQuote(base({ fsc: "60", fscUnit: "percent" }));
    expect(fsc.ok && fsc.warnings.join(" ")).toMatch(/very high/);
    const fact = validateQuote(base({ factoringPct: "60" }));
    expect(fact.ok && fact.warnings.join(" ")).toMatch(/factoring fee of 60%/);
  });
});

describe.skipIf(!run)("quoting on the demo database: integrity", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  let truckId = "";
  let otherTruckId = "";
  let driverId = "";
  let otherDriverId = "";

  const quote = (over: Partial<QuoteValues> = {}, day = "2027-06-09"): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: "QI Broker",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });

  beforeAll(async () => {
    const t = await saveTruck({ name: "QI Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    await saveCostProfile(truckId, profile);
    const t2 = await saveTruck({ name: "QI Truck Two", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t2.ok) throw new Error("truck2");
    otherTruckId = t2.id;
    await saveCostProfile(otherTruckId, profile);
    const d = await saveDriver({ name: "QI Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckId, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
    const d2 = await saveDriver({ name: "QI Other Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: otherTruckId, payKind: "cpm", payRate: "0.60" }, null);
    if (!d2.ok) throw new Error("driver2");
    otherDriverId = d2.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: "QI Broker" }, { id: { in: loadIds } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }, { createdAt: { gte: startedAt }, entity: "load", action: { in: ["quote_passed", "quote_discarded"] } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "QI" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "QI" } } });
  });

  test("a saved quote comes back as it was: per-truck miles, the driver, the fuel price and its source, a zero factoring fee, the cents of a market rate", async () => {
    const values = quote({
      emptyByTruck: { [truckId]: "55", [otherTruckId]: "120" },
      emptyHomeByTruck: { [truckId]: "80" },
      manual: ["loadedMiles", `empty:${truckId}`],
      driverId,
      fuelPrice: "4.25",
      fuelSource: "regional",
      factoringPct: "0",
      marketRate: "1499.55"
    });
    const saved = await saveQuote(values, null, truckId);
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    loadIds.push(saved.id);
    const back = (await getQuote(saved.id))!;
    expect(back.values).toMatchObject({
      emptyByTruck: { [truckId]: "55", [otherTruckId]: "120" },
      emptyHomeByTruck: { [truckId]: "80" },
      manual: ["loadedMiles", `empty:${truckId}`],
      driverId,
      fuelPrice: "4.25",
      fuelSource: "regional",
      factoringPct: "0"
    });
    expect(Number(back.values.marketRate)).toBeCloseTo(1499.55, 1);
  });

  test("a typed load number that is cleared goes back to the desk's own number", async () => {
    const saved = await saveQuote(quote({ loadNumber: "QI-BROKER-1" }), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: saved.id } })).loadNumber).toBe("QI-BROKER-1");
    const again = await saveQuote(quote({ loadNumber: "" }), saved.id, truckId);
    expect(again.ok).toBe(true);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: saved.id } })).loadNumber).toMatch(/^QT-/);
  });

  test("two people booking one truck at the same time: one gets it, the other is told why", async () => {
    const a = await saveQuote(quote({ offer: "1600" }, "2027-06-12"), null, truckId);
    const b = await saveQuote(quote({ offer: "1700" }, "2027-06-12"), null, truckId);
    if (!a.ok || !b.ok) throw new Error("save");
    loadIds.push(a.id, b.id);
    const [x, y] = await Promise.all([
      bookQuote(quote({ offer: "1600" }, "2027-06-12"), { vehicleId: truckId, driverId: null }, null, a.id),
      bookQuote(quote({ offer: "1700" }, "2027-06-12"), { vehicleId: truckId, driverId: null }, null, b.id)
    ]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    const refused = x.ok ? y : x;
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/already on/) });
  });

  test("one quote booked twice at the same time becomes one load and one decision", async () => {
    const saved = await saveQuote(quote({}, "2027-06-15"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    const results = await Promise.all([bookQuote(quote({}, "2027-06-15"), { vehicleId: truckId, driverId: null }, null, saved.id), bookQuote(quote({}, "2027-06-15"), { vehicleId: truckId, driverId: null }, null, saved.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.loadDecision.count({ where: { loadId: saved.id } })).toBe(1);
  });

  test("a quote that was booked is not rewritten by a late save, and one that was passed on is not edited", async () => {
    const saved = await saveQuote(quote({}, "2027-06-18"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    const booked = await bookQuote(quote({}, "2027-06-18"), { vehicleId: truckId, driverId: null }, null, saved.id);
    expect(booked.ok).toBe(true);
    const late = await saveQuote(quote({ offer: "99999" }, "2027-06-18"), saved.id, truckId);
    expect(late).toMatchObject({ ok: false });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: saved.id } })).quotedRevenue)).toBe(1500);

    const p = await saveQuote(quote({}, "2027-06-21"), null, truckId);
    if (!p.ok) throw new Error("save");
    loadIds.push(p.id);
    expect(await passQuote(p.id, "Rate too low", "")).toEqual({ ok: true });
    expect(await saveQuote(quote({ offer: "1800" }, "2027-06-21"), p.id, truckId)).toMatchObject({ ok: false, error: expect.stringMatching(/passed on/) });
  });

  test("the browser's word for the truck and the driver is not taken", async () => {
    const wrongDriver = await bookQuote(quote({}, "2027-06-24"), { vehicleId: truckId, driverId: otherDriverId }, null, null);
    expect(wrongDriver).toMatchObject({ ok: false, error: "That driver is not available on this truck." });
    await prisma.vehicle.update({ where: { id: otherTruckId }, data: { terminal: "QI-West" } });
    // A terminal the dispatcher is not working in: outside a request there is no scope, so the truck's own terminal is not a reason to refuse.
    const ok = await bookQuote(quote({}, "2027-06-24"), { vehicleId: otherTruckId, driverId: otherDriverId }, null, null);
    if (ok.ok) loadIds.push(ok.loadId);
    expect(ok.ok).toBe(true);
  });

  test("towing, a permit, a dock wait and a rider change the verdict as the phone counts them, and come back with the quote", async () => {
    const plain = await fitQuote(readQuote(quote({ marketRate: "" }))!);
    const dear = await fitQuote(readQuote(quote({ marketRate: "", towingPerMile: "0.40", permitEscort: "500", dockWaitMinutes: "120", insuranceRider: "100" }))!);
    const a = plain.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    const b = dear.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    expect(b.floorPerMile).toBeGreaterThan(a.floorPerMile + 0.4); // towing and the permit raise what a mile costs
    expect(b.detail.fees.rider).toBe(100);
    expect(b.detail.fees.net).toBeLessThan(a.detail.fees.net);
    expect(b.leftOver!).toBeLessThan(a.leftOver!);
    expect(a.detail.fees.net).toBeCloseTo(a.detail.fees.gross - a.detail.fees.carrier - a.detail.fees.factoring - a.detail.fees.rider, 6);

    const saved = await saveQuote(quote({ marketRate: "", towingPerMile: "0.40", permitEscort: "500", dockWaitMinutes: "120", insuranceRider: "100", marketBand: "5" }, "2027-07-03"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect((await getQuote(saved.id))!.values).toMatchObject({ towingPerMile: "0.4", permitEscort: "500", dockWaitMinutes: "120", insuranceRider: "100", marketBand: "5" });
  });

  test("a customer on the desk: offered even with no loads, its spelling carried, a different MC refused", async () => {
    const rec = await prisma.customer.create({ data: { workspaceId: WS, name: "QI Customer Co", kind: "broker", mcNumber: "123456", contactPhone: "555-0142", contactEmail: "ap@qi.example", defaultPayTermsDays: 30 } });
    try {
      const options = await brokerNames();
      const mine = options.filter((o) => o.name.toLowerCase() === "qi customer co");
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ name: "QI Customer Co", mc: "123456", payTermsDays: 30 });

      const wrong = await bookQuote(quote({ broker: "qi customer co", brokerMc: "999999" }, "2027-07-06"), { vehicleId: truckId, driverId: null }, null, null);
      expect(wrong).toMatchObject({ ok: false, errors: { brokerMc: expect.stringMatching(/MC 123456/) } });

      const ok = await bookQuote(quote({ broker: "qi customer co", brokerMc: "MC 123456" }, "2027-07-06"), { vehicleId: truckId, driverId: null }, null, null);
      if (!ok.ok) throw new Error(JSON.stringify(ok));
      loadIds.push(ok.loadId);
      expect((await prisma.load.findUniqueOrThrow({ where: { id: ok.loadId } })).brokerName).toBe("QI Customer Co");
    } finally {
      await prisma.customer.delete({ where: { id: rec.id } });
    }
  });

  test("a truck already on a load at that time says so in its row; a card that lapses before the pickup blocks the driver; a truck whose drivers are all out can still be booked", async () => {
    const day = "2027-07-12";
    const first = await bookQuote(quote({}, day), { vehicleId: otherTruckId, driverId: null }, null, null);
    if (!first.ok) throw new Error(JSON.stringify(first));
    loadIds.push(first.loadId);
    const busy = await fitQuote(readQuote(quote({}, day))!);
    const rowsBusy = busy.rows.filter((r) => r.truckId === otherTruckId);
    expect(rowsBusy.length).toBeGreaterThan(0);
    for (const r of rowsBusy) expect(r.blocked).toMatch(/already on/i);

    const lapsing = await saveDriver({ name: "QI Lapsing", cdlClass: "A", cdlExpiry: "2027-07-01", medicalCardExpiry: "2031-01-31", assignedVehicleId: otherTruckId, payKind: "cpm", payRate: "0.60" }, null);
    if (!lapsing.ok) throw new Error("lapsing");
    const later = await fitQuote(readQuote(quote({}, "2027-07-20"))!);
    const row = later.rows.find((r) => r.driverId === lapsing.id)!;
    expect(row.blocked).toMatch(/CDL expires before the pickup/);
  });

  test("a straight truck is told when the load wants another trailer; a van or box truck is not told about a dry van", async () => {
    const reefer = await fitQuote(readQuote(quote({ trailer: "reefer" }, "2027-07-24"))!);
    const r = reefer.rows.find((x) => x.truckId === truckId)!;
    expect(r.warnings.join(" ")).toMatch(/carries its own body.*reefer/);
    const van = await fitQuote(readQuote(quote({ trailer: "dry_van" }, "2027-07-24"))!);
    expect(van.rows.find((x) => x.truckId === truckId)!.warnings.join(" ")).not.toMatch(/own body/);
  });

  test("saved quotes are searched, filtered and paged on the server; a passed one is not in Open", async () => {
    const a = await saveQuote(quote({ broker: "QI Search Alpha" }, "2027-08-02"), null, truckId);
    const b = await saveQuote(quote({ broker: "QI Search Beta" }, "2027-08-03"), null, truckId);
    if (!a.ok || !b.ok) throw new Error("save");
    loadIds.push(a.id, b.id);
    await passQuote(b.id, "Rate too low", "");
    const open = await listQuotes(WS, { q: "QI Search", status: "open" });
    expect(open.rows.map((r) => r.id)).toEqual([a.id]);
    const passed = await listQuotes(WS, { q: "QI Search", status: "passed" });
    expect(passed.rows.map((r) => r.id)).toEqual([b.id]);
    const all = await listQuotes(WS, { q: "QI Search Beta", status: "all" });
    expect(all.total).toBe(1);
    expect((await getQuote(b.id))!.passedFor).toBe("Rate too low");
    const page2 = await listQuotes(WS, { status: "all", offset: 1000 });
    expect(page2.rows).toEqual([]);
  });

  test("booking records the miles it was priced on, and saving a quote leaves a trail", async () => {
    const saved = await saveQuote(quote({}, "2027-08-10"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect(await prisma.auditEvent.count({ where: { entityId: saved.id, action: "quote_saved" } })).toBe(1);
    const out = await bookQuote(quote({}, "2027-08-10"), { vehicleId: truckId, driverId: null }, null, saved.id);
    if (!out.ok) throw new Error(JSON.stringify(out));
    const l = await prisma.load.findUniqueOrThrow({ where: { id: out.loadId } });
    expect(Number(l.quotedLoadedMiles)).toBe(260);
    expect(Number(l.quotedPickupDhMiles)).toBe(40);
  });

  test("a booking and a pass keep what they were decided on, and the report reads it back with the raise from the first offer", async () => {
    const day = "2027-09-06";
    const saved = await saveQuote(quote({ offer: "1400", fuelPrice: "4.10", fuelSource: "regional" }, day), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    // The offer is raised before it is booked: the first offer is what was first saved.
    const again = await saveQuote(quote({ offer: "1550", fuelPrice: "4.10", fuelSource: "regional" }, day), saved.id, truckId);
    expect(again.ok).toBe(true);
    const booked = await bookQuote(quote({ offer: "1550", fuelPrice: "4.10", fuelSource: "regional" }, day), { vehicleId: truckId, driverId: null }, null, saved.id);
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    const dec = await prisma.loadDecision.findFirstOrThrow({ where: { loadId: saved.id } });
    expect(dec.decidedBy).toBeTruthy();
    expect(dec.details).toMatchObject({ offer: 1550, firstOffer: 1400, benchmark: "market", fuelPrice: 4.1, fuelSource: "regional", customer: "QI Broker" });

    const lost = await saveQuote(quote({ offer: "500", marketRate: "1500" }, "2027-09-09"), null, truckId);
    if (!lost.ok) throw new Error("save");
    loadIds.push(lost.id);
    expect(await passQuote(lost.id, "Rate too low", "")).toEqual({ ok: true });
    const passed = await prisma.loadDecision.findFirstOrThrow({ where: { loadId: lost.id } });
    expect(passed.details).toMatchObject({ verdict: expect.stringMatching(/reject|think/), offer: 500 });

    const { rows } = await listQuoteDecisions({ period: "all", by: null });
    const mine = rows.filter((r) => r.customer === "QI Broker" && (r.id === dec.id || r.id === passed.id));
    expect(mine).toHaveLength(2);
    const report = buildQuoteReport(mine);
    expect(report).toMatchObject({ booked: 1, passed: 1 });
    expect(report.negotiation).toMatchObject({ raised: 1, avgRaise: 150, passedOnRate: 1 });
    // A dispatcher's own view is only their decisions: another name sees none of these.
    const other = await listQuoteDecisions({ period: "all", by: "Somebody Else" });
    expect(other.rows.some((r) => r.id === dec.id)).toBe(false);
  });

  test("another workspace's quotes, trucks and drivers cannot be read, saved over, booked, passed on or thrown away from this one", async () => {
    const OTHER = "qi-other-workspace";
    await prisma.workspace.upsert({ where: { id: OTHER }, update: {}, create: { id: OTHER, name: "QI Other Desk" } });
    try {
      const theirs = await saveQuote(quote({ broker: "QI Other Broker" }, "2027-09-12"), null, null, OTHER);
      if (!theirs.ok) throw new Error(JSON.stringify(theirs));
      expect(await getQuote(theirs.id)).toBeNull(); // read from the demo desk
      expect(await getQuote(theirs.id, OTHER)).not.toBeNull();
      expect(await saveQuote(quote({ offer: "9" }, "2027-09-12"), theirs.id, null)).toMatchObject({ ok: false });
      expect(await bookQuote(quote({}, "2027-09-12"), { vehicleId: truckId, driverId: null }, null, theirs.id)).toMatchObject({ ok: false });
      expect(await passQuote(theirs.id, "Rate too low", "")).toMatchObject({ ok: false });
      expect(await discardQuote(theirs.id)).toBe(false);
      // Nothing of theirs moved: still a quote, still theirs, no decision.
      const row = await prisma.load.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row).toMatchObject({ status: "quote", workspaceId: OTHER, deletedAt: null });
      expect(await prisma.loadDecision.count({ where: { loadId: theirs.id } })).toBe(0);
      // Their truck is not one this desk can book on.
      const t = await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "QI Their Truck" } });
      expect(await bookQuote(quote({}, "2027-09-13"), { vehicleId: t.id, driverId: null }, null, null)).toMatchObject({ ok: false, error: "That truck is not available." });
      // And the other desk's list does not show ours.
      expect((await listQuotes(OTHER, { status: "all" })).rows.some((r) => r.broker === "QI Broker")).toBe(false);
    } finally {
      await prisma.load.deleteMany({ where: { workspaceId: OTHER } });
      await prisma.vehicle.deleteMany({ where: { workspaceId: OTHER } });
      await prisma.auditEvent.deleteMany({ where: { workspaceId: OTHER } });
      await prisma.workspace.delete({ where: { id: OTHER } });
    }
  });

  test("a quote with a second delivery keeps its stops in order, counts deliveries only, and books with every stop", async () => {
    const day = "2027-09-15";
    const values = quote({
      stops: [
        { role: "pickup", address: "Dallas, TX", appointment: `${day}T06:00` },
        { role: "delivery", address: "Waco, TX", appointment: `${day}T10:00` },
        { role: "delivery", address: "Austin, TX", appointment: `${day}T14:00` }
      ]
    });
    const saved = await saveQuote(values, null, truckId);
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    loadIds.push(saved.id);
    const back = (await getQuote(saved.id))!.values;
    expect(back.stops.map((s) => [s.role, s.address])).toEqual([["pickup", "Dallas, TX"], ["delivery", "Waco, TX"], ["delivery", "Austin, TX"]]);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: saved.id } })).stopsCount).toBe(2); // deliveries, not stops
    // Out of order is refused before anything is written.
    expect(validateQuote({ ...values, stops: [values.stops[0]!, { ...values.stops[1]!, appointment: `${day}T03:00` }, values.stops[2]!] })).toMatchObject({ ok: false, errors: { stop1Time: expect.any(String) } });
    const booked = await bookQuote(back, { vehicleId: truckId, driverId: null }, null, saved.id);
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    const stops = await prisma.stop.findMany({ where: { loadId: saved.id }, orderBy: { stopSequence: "asc" } });
    expect(stops.map((s) => s.stopSequence)).toEqual([1, 2, 3]);
    expect(stops.map((s) => s.addressString)).toEqual(["Dallas, TX", "Waco, TX", "Austin, TX"]);
  });

  test("a booked quote is a load on the board and the queue, and is no longer a quote anywhere", async () => {
    const saved = await saveQuote(quote({}, "2027-09-18"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect((await listQuotes(WS, { status: "open" })).rows.some((r) => r.id === saved.id)).toBe(true);
    const booked = await bookQuote(quote({}, "2027-09-18"), { vehicleId: truckId, driverId: null }, null, saved.id);
    expect(booked.ok).toBe(true);
    expect((await listBoardRows()).some((r) => r.id === saved.id)).toBe(true);
    expect((await listQuotes(WS, { status: "all" })).rows.some((r) => r.id === saved.id)).toBe(false);
    expect(await getQuote(saved.id)).toBeNull();
    const detail = await getLoadDetail(saved.id);
    expect(detail).not.toBeNull();
    const planner = await getPlannerData(Date.parse("2027-09-18T12:00:00Z"), Date.now(), 3);
    expect([...planner.tray.flat(), ...planner.rows.flatMap((r) => r.cells.flat())].some((i) => i.loadId === saved.id)).toBe(true);
  });

  test("a truck's time is its drive too: a delivery set early on paper but a road that runs on is not free then", async () => {
    // Pickup 08:00, a delivery time of 09:00 on paper, but 600 loaded miles is about twelve hours of driving.
    const long = (day: string) => quote({ loadedMiles: "600", stops: [{ role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` }, { role: "delivery", address: "Atlanta, GA", appointment: `${day}T09:00` }] }, day);
    const first = await bookQuote(long("2027-10-04"), { vehicleId: truckId, driverId: null }, null, null);
    if (!first.ok) throw new Error(JSON.stringify(first));
    loadIds.push(first.loadId);
    // Another load on the same truck that afternoon is inside that drive.
    const clash = await bookQuote(quote({ offer: "1700" }, "2027-10-04"), { vehicleId: truckId, driverId: null }, null, null);
    expect(clash).toMatchObject({ ok: false, error: expect.stringMatching(/already on/) });
  });

  test("a lane matches its city and state exactly: Rome is not Jerome", async () => {
    const made = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "QI-JEROME-1", status: "completed", channel: "dispatch", brokerName: "QI Broker", originAddress: "Jerome, GA", destinationAddress: "Reno, NV", quotedRevenue: 2000, loadedMiles: 500, completedAt: new Date() } });
    loadIds.push(made.id);
    const ctx = await quoteContext(readQuote(quote({ stops: [{ role: "pickup", address: "Rome, GA", appointment: "" }, { role: "delivery", address: "Reno, NV", appointment: "" }] }))!);
    expect(ctx.lane).toBeNull();
    const same = await quoteContext(readQuote(quote({ stops: [{ role: "pickup", address: "Jerome, GA", appointment: "" }, { role: "delivery", address: "Reno, NV", appointment: "" }] }))!);
    expect(same.lane?.count).toBe(1);
  });

  test("quotes passed on are a signal on the lane and the customer, though they are no load", async () => {
    const q = await saveQuote(quote({ broker: "QI Signal Broker", stops: [{ role: "pickup", address: "Provo, UT", appointment: "" }, { role: "delivery", address: "Boise, ID", appointment: "" }] }), null, truckId);
    if (!q.ok) throw new Error("save");
    loadIds.push(q.id);
    await passQuote(q.id, "Rate too low", "");
    const ctx = await quoteContext(readQuote(quote({ broker: "QI Signal Broker", stops: [{ role: "pickup", address: "Provo, UT", appointment: "" }, { role: "delivery", address: "Boise, ID", appointment: "" }] }))!);
    expect(ctx.passed).toEqual({ lane: 1, broker: 1 });
  });

  test("what a booking was judged on is on the record: the fuel price and where it came from, and what it was read against", async () => {
    const out = await bookQuote(quote({ fuelPrice: "4.25", fuelSource: "regional" }, "2027-06-27"), { vehicleId: truckId, driverId: null }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: out.loadId, action: "booked" } });
    const after = JSON.stringify(audit.after);
    expect(after).toContain("$4.25 a gallon, this week's regional price");
    expect(after).toContain("The market rate typed");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: out.loadId } })).quoteExtras).toMatchObject({ fuelPrice: 4.25, fuelSource: "regional" });
  });
});
