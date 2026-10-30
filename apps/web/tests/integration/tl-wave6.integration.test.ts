import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote, validateQuote, type QuoteValues } from "@/lib/quote";
import { getAlerts } from "@/server/tl/alerts";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { getKpiRows } from "@/server/tl/kpi";
import { getPlannerData } from "@/server/tl/planner";
import { getLoadDetail, listBoardRows } from "@/server/tl/queries";
import { listTrucksPage } from "@/server/tl/fleet-list";
import { bookQuote, discardQuote, fitQuote, getQuote, listQuotes, quoteContext, saveQuote } from "@/server/tl/quote";
import { searchDesk } from "@/server/tl/search";
import { getShellData } from "@/server/tl/shell";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own truck, drivers and quotes (all named W6) and removes them and
 * their audit events afterwards, so the demo data is left as the seed wrote it.
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

describe.skipIf(!run)("quoting a load on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  let truckId = "";
  let driverId = "";
  let lapsedId = "";

  // One Dallas day in the far future, so nothing seeded is on the road then.
  const quote = (over: Partial<QuoteValues> = {}, day = "2027-02-09"): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: "W6 Broker",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });
  const input = (v: QuoteValues) => {
    const r = readQuote(v);
    if (!r) throw new Error("not priceable");
    return r;
  };

  beforeAll(async () => {
    const t = await saveTruck({ name: "W6 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    const p = await saveCostProfile(truckId, profile);
    if (!p.ok) throw new Error(`profile ${JSON.stringify(p)}`);
    const d = await saveDriver({ name: "W6 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckId, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
    const lapsed = await saveDriver({ name: "W6 Lapsed", cdlClass: "A", cdlExpiry: "2020-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckId }, null);
    if (!lapsed.ok) throw new Error("lapsed");
    lapsedId = lapsed.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: "W6 Broker" }, { id: { in: loadIds } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W6" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W6" } } });
  });

  test("an offer is priced for every truck and driver, best first, each with its own labour", async () => {
    const fit = await fitQuote(input(quote()));
    const trucks = await prisma.vehicle.count({ where: { workspaceId: WS, archivedAt: null } });
    expect(new Set(fit.rows.map((r) => r.truckId)).size).toBe(trucks);
    const mine = fit.rows.filter((r) => r.truckId === truckId);
    expect(mine.map((r) => r.driverName).sort()).toEqual(["W6 Driver", "W6 Lapsed"]);

    const usual = mine.find((r) => r.driverId === driverId)!;
    expect(usual.labourNote).toMatch(/Driver pay from this assignment: \$0\.60 a mile/); // the driver's usual pay counts
    const plain = mine.find((r) => r.driverName === "W6 Lapsed")!;
    expect(plain.labourNote).toMatch(/owner drives/); // no usual pay: the truck's profile decides
    expect(usual.allInPerMile).toBeCloseTo(1500 / 540, 3); // every mile counts: 40 + 260 + 240
    expect(usual.marginPerMile!).toBeLessThan(plain.marginPerMile!); // paying a driver leaves less
    expect(usual.leftOver).toBeCloseTo(usual.marginPerMile! * usual.totalMiles, 4);

    // Best first, and a driver who cannot take it goes last.
    expect(plain.blocked).toBe("CDL expired");
    const order = fit.rows.map((r) => (r.blocked ? 1 : 0));
    expect(order).toEqual([...order].sort());
    for (let i = 1; i < fit.rows.length; i++) {
      if (!fit.rows[i]!.blocked && !fit.rows[i - 1]!.blocked) expect(fit.rows[i - 1]!.marginPerMile!).toBeGreaterThanOrEqual(fit.rows[i]!.marginPerMile!);
    }
  });

  test("empty miles can differ by truck, and a load back drops the way home", async () => {
    const base = await fitQuote(input(quote()));
    const near = await fitQuote(input(quote({ emptyByTruck: { [truckId]: "0" } })));
    const a = base.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    const b = near.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    expect(b.emptyToPickup).toBe(0);
    expect(b.totalMiles).toBe(a.totalMiles - 40);
    expect(b.marginPerMile!).toBeGreaterThan(a.marginPerMile!);
    const covered = await fitQuote(input(quote({ loadBack: true })));
    expect(covered.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!.totalMiles).toBe(300);
  });

  test("a offer that does not cover its costs, or has no market rate, needs a reason; a clean one does not", async () => {
    const low = await fitQuote(input(quote({ offer: "300", marketRate: "300" })));
    const row = low.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    expect(row.decision).toBe("reject");
    expect(row.gate).toBe("below_floor");
    expect(row.detail.payNeeded).toBeGreaterThan(300);
    const noMarket = await fitQuote(input(quote({ marketRate: "" })));
    expect(noMarket.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!.gate).toBe("no_market");
    const clean = await fitQuote(input(quote()));
    const ok = clean.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    expect(ok.gate).toBeNull();
    expect(ok.band).toBe("at_market");
  });

  test("a saved quote is not a load: it stays off the board, the counts, the alerts, the planner, the KPIs and the search", async () => {
    const countsBefore = (await getShellData()).counts;
    const boardBefore = (await listBoardRows()).length;
    const saved = await saveQuote(quote({ broker: "W6 Broker", offer: "1234" }), null, truckId);
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    loadIds.push(saved.id);

    expect((await listQuotes()).map((q) => q.id)).toContain(saved.id);
    expect((await listBoardRows()).length).toBe(boardBefore);
    expect((await listBoardRows()).some((r) => r.id === saved.id)).toBe(false);
    expect((await getShellData()).counts).toEqual(countsBefore);
    expect((await getAlerts()).alerts.some((a) => a.loadId === saved.id)).toBe(false);
    expect((await getKpiRows()).some((r) => r.id === saved.id)).toBe(false);
    expect(await getLoadDetail(saved.id)).toBeNull();
    const planner = await getPlannerData(Date.parse("2027-02-09T12:00:00Z"), Date.now(), 3);
    expect([...planner.tray.flat(), ...planner.rows.flatMap((r) => r.cells.flat())].some((i) => i.loadId === saved.id)).toBe(false);
    expect((await searchDesk("W6 Broker")).some((h) => h.kind === "broker")).toBe(false);
    const truck = (await listTrucksPage({ q: "W6", pageSize: 200 })).rows.find((t) => t.id === truckId)!;
    expect(truck.loads).toBe(0);
    expect(truck.open).toBe(0);
  });

  test("reopening a quote brings the form back as it was, the surcharge in the unit it was typed in", async () => {
    const values = quote({ broker: "W6 Broker", offer: "1800", fsc: "0.35", fscUnit: "per_mile", marketRate: "1900", payTermsDays: "30", factoringPct: "2.5", trailer: "dry_van", loadBack: true, emptyToPickup: "25", emptyHome: "100" });
    const saved = await saveQuote(values, null, null);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    const back = (await getQuote(saved.id))!;
    expect(back.vehicleId).toBeNull();
    expect(back.values.stops).toEqual(values.stops);
    expect(back.values).toMatchObject({ broker: "W6 Broker", offer: "1800", fscUnit: "per_mile", payTermsDays: "30", factoringPct: "2.5", trailer: "dry_van", loadBack: true, emptyToPickup: "25", emptyHome: "100", loadedMiles: "260" });
    expect(Number(back.values.fsc)).toBeCloseTo(0.35, 3);
    expect(Number(back.values.marketRate)).toBeCloseTo(1900, 0); // typed as a total, kept per mile, read back as a total
    // The same form priced again gives the same answer.
    expect(validateQuote(back.values).ok).toBe(true);
    // Updating it rewrites it rather than adding another.
    const again = await saveQuote({ ...back.values, offer: "1850" }, saved.id, truckId);
    expect(again).toEqual({ ok: true, id: saved.id });
    expect((await getQuote(saved.id))!.values.offer).toBe("1850");
    expect((await getQuote(saved.id))!.vehicleId).toBe(truckId);
    expect((await listQuotes()).filter((q) => q.id === saved.id)).toHaveLength(1);
  });

  test("a discarded quote is gone from the list and cannot be reopened", async () => {
    const saved = await saveQuote(quote({ broker: "W6 Broker" }), null, null);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect(await discardQuote(saved.id)).toBe(true);
    expect(await getQuote(saved.id)).toBeNull();
    expect((await listQuotes()).some((q) => q.id === saved.id)).toBe(false);
    expect(await discardQuote(saved.id)).toBe(false);
  });

  test("booking needs both times, a truck with a cost profile, and for a load that needs one, a reason", async () => {
    const noTimes = quote({ stops: [{ role: "pickup", address: "Dallas, TX", appointment: "" }, { role: "delivery", address: "Tulsa, OK", appointment: "" }] });
    const a = await bookQuote(noTimes, { vehicleId: truckId, driverId: null }, null, null);
    expect(a).toMatchObject({ ok: false, errors: { stop0Time: expect.any(String), stop1Time: expect.any(String) } });

    const bare = await saveTruck({ name: "W6 Bare", type: "pickup" }, null);
    if (!bare.ok) throw new Error("bare");
    const b = await bookQuote(quote(), { vehicleId: bare.id, driverId: null }, null, null);
    expect(b).toMatchObject({ ok: false, error: expect.stringMatching(/no cost profile/) });

    const lowValues = quote({ offer: "300", marketRate: "300" });
    const needs = await bookQuote(lowValues, { vehicleId: truckId, driverId: null }, null, null);
    expect(needs).toMatchObject({ ok: false, gate: "below_floor" });
    const other = await bookQuote(lowValues, { vehicleId: truckId, driverId: null }, { reason: "Other", notes: "" }, null);
    expect(other).toMatchObject({ ok: false, error: "Say what the reason is when you pick Other." });
    const bogus = await bookQuote(lowValues, { vehicleId: truckId, driverId: null }, { reason: "Because", notes: "" }, null);
    expect(bogus).toMatchObject({ ok: false, gate: "below_floor" });
    expect(await prisma.load.count({ where: { workspaceId: WS, brokerName: "W6 Broker", status: "draft" } })).toBe(0); // none of those wrote a load
  });

  test("booking an override writes the decision with its reason, freezes the floor, shows on the board and in the audit log", async () => {
    const out = await bookQuote(quote({ offer: "300", marketRate: "300" }, "2027-02-16"), { vehicleId: truckId, driverId: null }, { reason: "Positioning for return load", notes: "Back to Dallas for a Friday pickup" }, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    const l = await prisma.load.findUniqueOrThrow({ where: { id: out.loadId }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(l.status).toBe("draft");
    expect(l.vehicleId).toBe(truckId);
    expect(l.channel).toBe("dispatch");
    expect(l.loadNumber).toMatch(/^QT-/);
    expect(l.stops.map((s) => s.stopRole)).toEqual(["pickup", "delivery"]);
    expect(l.stops[0]!.timeWindowEarliest!.toISOString()).toBe("2027-02-16T14:00:00.000Z");
    expect(l.scheduledDate!.toISOString()).toBe("2027-02-16T14:00:00.000Z");
    expect(num(l.snapshotBaseFloorRpm)).toBeGreaterThan(0); // the floor it was booked at
    const d = await prisma.loadDecision.findFirstOrThrow({ where: { loadId: out.loadId } });
    expect(d).toMatchObject({ decisionType: "overridden", overrideReason: "Positioning for return load", overrideNotes: "Back to Dallas for a Friday pickup" });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: out.loadId, action: "booked" } });
    expect(ev.reason).toBe("Positioning for return load: Back to Dallas for a Friday pickup");
    expect(ev.summary).toMatch(/Booked from a quote: Dallas, TX to Tulsa, OK, \$300 on W6 Truck, an override/);
    expect((await listBoardRows()).some((r) => r.id === out.loadId)).toBe(true);
    expect((await getLoadDetail(out.loadId))!.load.id).toBe(out.loadId);
  });

  test("a clean load books as accepted, from a saved quote, with its driver on it; a second try says it is gone", async () => {
    const saved = await saveQuote(quote({ broker: "W6 Broker" }, "2027-02-23"), null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    const out = await bookQuote(quote({ broker: "W6 Broker" }, "2027-02-23"), { vehicleId: truckId, driverId }, null, saved.id);
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.loadId).toBe(saved.id); // booking the quote changes it, it does not copy it
    expect(out.assigned).toBe(true);
    const d = await prisma.loadDecision.findFirstOrThrow({ where: { loadId: out.loadId } });
    expect(d).toMatchObject({ decisionType: "accepted", overrideReason: null });
    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId: out.loadId } });
    expect(a.driverId).toBe(driverId);
    expect(a.payKind).toBe("cpm");
    expect(num(a.payRate)).toBe(0.6); // the driver's usual pay
    const l = await prisma.load.findUniqueOrThrow({ where: { id: out.loadId } });
    expect(l.status).toBe("draft");
    expect(num(l.snapshotLaborCpm)).toBeCloseTo(0.6 * 1.18, 3); // the assignment froze the pay
    expect(await listQuotes().then((q) => q.some((x) => x.id === saved.id))).toBe(false);
    expect(await bookQuote(quote({ broker: "W6 Broker" }, "2027-02-23"), { vehicleId: truckId, driverId: null }, null, saved.id)).toMatchObject({ ok: false, error: "That quote is gone." });
  });

  test("a driver who is already on a load at that time cannot take it: the row says so, and booking with them still books the load", async () => {
    // The driver is on the 23 Feb load from the test above, 08:00 to 17:00 Dallas time.
    const fit = await fitQuote(input(quote({}, "2027-02-23")));
    const row = fit.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    expect(row.blocked).toMatch(/Already on QT-/);
    const out = await bookQuote(quote({ broker: "W6 Broker" }, "2027-02-23"), { vehicleId: truckId, driverId }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    expect(out.assigned).toBe(false);
    expect(out.note).toMatch(/Booked, but W6 Driver could not be assigned: .*already on/);
    expect(await prisma.assignment.count({ where: { loadId: out.loadId } })).toBe(0);
    // A lapsed card is refused the same way.
    const lapsed = await bookQuote(quote({ broker: "W6 Broker" }, "2027-03-02"), { vehicleId: truckId, driverId: lapsedId }, null, null);
    if (!lapsed.ok) throw new Error("lapsed");
    loadIds.push(lapsed.loadId);
    expect(lapsed.assigned).toBe(false);
  });

  test("what the desk already knows about a lane and a broker comes with the price", async () => {
    const lane = await prisma.load.findFirstOrThrow({ where: { workspaceId: WS, status: "completed", deletedAt: null }, orderBy: { completedAt: "desc" } });
    const from = lane.originAddress!;
    const to = lane.destinationAddress!;
    const ctx = await quoteContext(input(quote({ stops: [{ role: "pickup", address: from, appointment: "" }, { role: "delivery", address: to, appointment: "" }], broker: lane.brokerName ?? "" })));
    expect(ctx.lane).not.toBeNull();
    expect(ctx.lane!.count).toBeGreaterThan(0);
    expect(ctx.lane!.recent[0]!.perMile).toBeGreaterThan(0);
    expect(ctx.broker).not.toBeNull();
    expect(ctx.broker!.finished).toBeGreaterThan(0);
    expect(ctx.broker!.loads).toBeGreaterThanOrEqual(ctx.broker!.finished + ctx.broker!.fellThrough);
    // A lane and a broker the desk has never seen have nothing to say.
    const none = await quoteContext(input(quote({ stops: [{ role: "pickup", address: "Nowhereville, ZZ", appointment: "" }, { role: "delivery", address: "Elsewhere, ZZ", appointment: "" }], broker: "No Such Broker" })));
    expect(none).toEqual({ lane: null, broker: null });
  });
});
