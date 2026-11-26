import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote, tooManyDecimals, validateQuote, type QuoteValues } from "@/lib/quote";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { bookQuote, discardQuote, fitQuote, passQuote, quoteContext, saveQuote, STALE_QUOTE } from "@/server/tl/quote";

/**
 * Quote, review round two (Q1): a quote is held to the person's terminals on every write, a pass and a booking cannot both land, a save over someone else's newer change is refused, a
 * pickup long past is asked about, each truck is busy from the time it has to leave its own base, the driver's cards and hours are read the way assigning reads them, and driver pay
 * stays with the people who may see it. Makes its own trucks and drivers (named Q1) and removes them afterwards.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const BROKER = "Q1 Broker";

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

describe("money is typed to the cent", () => {
  const base = (over: Partial<QuoteValues> = {}): QuoteValues => ({ ...BLANK_QUOTE, stops: [{ role: "pickup", address: "Dallas, TX", appointment: "" }, { role: "delivery", address: "Tulsa, OK", appointment: "" }], offer: "1500", loadedMiles: "260", ...over });

  test("more than two decimals on money, or three on a rate a mile, is marked", () => {
    expect(tooManyDecimals("1500.555", 2)).toBe(true);
    expect(tooManyDecimals("1,500.55", 2)).toBe(false);
    expect(tooManyDecimals("1500", 2)).toBe(false);
    expect(validateQuote(base({ offer: "1500.555" }))).toMatchObject({ ok: false, errors: { offer: expect.stringMatching(/two decimal/) } });
    expect(validateQuote(base({ marketRate: "1800.001" }))).toMatchObject({ ok: false, errors: { marketRate: expect.any(String) } });
    expect(validateQuote(base({ fsc: "0.4555", fscUnit: "per_mile" }))).toMatchObject({ ok: false, errors: { fsc: expect.any(String) } });
    expect(validateQuote(base({ fsc: "0.455", fscUnit: "per_mile" })).ok).toBe(true);
    expect(validateQuote(base({ offer: "1500.50", towingPerMile: "0.125" })).ok).toBe(true);
  });
});

describe.skipIf(!run)("Quote Q1 on the demo database", () => {
  const startedAt = new Date();
  let east = ""; // truck in Q1-East
  let west = ""; // truck in Q1-West
  let eastDriver = "";
  let tiredDriver = "";
  let tiredTruck = "";

  const quote = (day: string, over: Partial<QuoteValues> = {}, times: [string, string] = ["08:00", "17:00"]): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T${times[0]}` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T${times[1]}` }
    ],
    broker: BROKER,
    offer: "1500",
    loadedMiles: "260",
    loadedHours: "4",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });

  beforeAll(async () => {
    const t = await saveTruck({ name: "Q1 East", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const t2 = await saveTruck({ name: "Q1 West", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const t3 = await saveTruck({ name: "Q1 Tired", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok || !t2.ok || !t3.ok) throw new Error("trucks");
    east = t.id;
    west = t2.id;
    tiredTruck = t3.id;
    for (const id of [east, west, tiredTruck]) await saveCostProfile(id, profile);
    await prisma.vehicle.update({ where: { id: east }, data: { terminal: "Q1-East" } });
    await prisma.vehicle.update({ where: { id: west }, data: { terminal: "Q1-West" } });
    const d = await saveDriver({ name: "Q1 Driver", cdlClass: "A", cdlExpiry: "2035-01-31", medicalCardExpiry: "2035-01-31", assignedVehicleId: east, payKind: "cpm", payRate: "0.60" }, null);
    const d2 = await saveDriver({ name: "Q1 Tired Driver", cdlClass: "A", cdlExpiry: "2035-01-31", medicalCardExpiry: "2035-01-31", assignedVehicleId: tiredTruck, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok || !d2.ok) throw new Error("drivers");
    eastDriver = d.id;
    tiredDriver = d2.id;
    await prisma.driver.update({ where: { id: eastDriver }, data: { terminal: "Q1-East" } });
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: BROKER }, { vehicleId: { in: [east, west, tiredTruck] } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }, { createdAt: { gte: startedAt }, entity: "load", action: { in: ["quote_saved", "quote_passed", "quote_discarded", "booked"] }, summary: { contains: BROKER } }] } });
    await prisma.assignment.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { workspaceId: WS, name: BROKER } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q1 " } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q1 " } } });
  });

  test("a quote on another terminal's truck cannot be saved over, thrown away or booked by id; a truck outside the limit cannot be saved on", async () => {
    const s = await saveQuote(quote("2031-03-03"), null, east);
    if (!s.ok) throw new Error("save");
    const away = { allowed: "Q1-West" };
    expect(await saveQuote(quote("2031-03-03", { offer: "1700" }), s.id, east, WS, new Date(), away)).toMatchObject({ ok: false });
    expect(await saveQuote(quote("2031-03-03", { offer: "1700" }), s.id, west, WS, new Date(), away)).toMatchObject({ ok: false, error: "That quote is gone." });
    expect(await discardQuote(s.id, WS, new Date(), "Q1-West")).toBe(false);
    expect(await bookQuote(quote("2031-03-03"), { vehicleId: west, driverId: null }, null, s.id, WS, new Date(), away)).toMatchObject({ ok: false });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: s.id } })).quotedRevenue)).toBe(1500);
    expect(await saveQuote(quote("2031-03-04"), null, east, WS, new Date(), away)).toMatchObject({ ok: false, error: expect.stringMatching(/outside the terminals/) });
    // Inside the limit, all is as before.
    expect(await saveQuote(quote("2031-03-03", { offer: "1600" }), s.id, east, WS, new Date(), { allowed: "Q1-East" })).toMatchObject({ ok: true });
    expect(await discardQuote(s.id, WS, new Date(), "Q1-East")).toBe(true);
  });

  test("a quote passed on cannot be booked, and one booked cannot be passed on", async () => {
    const a = await saveQuote(quote("2031-03-05"), null, east);
    if (!a.ok) throw new Error("save");
    expect(await passQuote(a.id, "Rate too low", "", WS, new Date(), null)).toEqual({ ok: true });
    expect(await bookQuote(quote("2031-03-05"), { vehicleId: east, driverId: null }, null, a.id)).toMatchObject({ ok: false, error: expect.stringMatching(/passed on/) });
    expect(await prisma.loadDecision.count({ where: { loadId: a.id } })).toBe(1);

    const b = await saveQuote(quote("2031-03-06"), null, east);
    if (!b.ok) throw new Error("save");
    expect(await bookQuote(quote("2031-03-06"), { vehicleId: east, driverId: null }, null, b.id)).toMatchObject({ ok: true });
    expect(await passQuote(b.id, "Rate too low", "", WS, new Date(), null)).toMatchObject({ ok: false });
    expect((await prisma.loadDecision.findMany({ where: { loadId: b.id } })).map((d) => d.decisionType)).toEqual(["accepted"]);
  });

  test("a save or a booking over someone else's newer change is refused", async () => {
    const first = await saveQuote(quote("2031-03-07"), null, east);
    if (!first.ok) throw new Error("save");
    const mine = await saveQuote(quote("2031-03-07", { offer: "1800" }), first.id, east, WS, new Date(), { version: first.version });
    if (!mine.ok) throw new Error("second save");
    // Another tab still holds the first version.
    expect(await saveQuote(quote("2031-03-07", { offer: "1500" }), first.id, east, WS, new Date(), { version: first.version })).toMatchObject({ ok: false, error: STALE_QUOTE, stale: true });
    expect(await bookQuote(quote("2031-03-07", { offer: "1500" }), { vehicleId: east, driverId: null }, null, first.id, WS, new Date(), { version: first.version })).toMatchObject({ ok: false, stale: true });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: first.id } })).quotedRevenue)).toBe(1800);
    expect(await bookQuote(quote("2031-03-07", { offer: "1800" }), { vehicleId: east, driverId: null }, null, first.id, WS, new Date(), { version: mine.version })).toMatchObject({ ok: true });
  });

  test("a pickup more than a day past is booked only when the person says so", async () => {
    const past = quote("2020-03-09");
    expect(await bookQuote(past, { vehicleId: west, driverId: null }, null, null)).toMatchObject({ ok: false, pastPickup: true });
    expect(await bookQuote(past, { vehicleId: west, driverId: null }, null, null, WS, new Date(), { pastOk: true })).toMatchObject({ ok: true });
  });

  test("a truck is busy from when it has to leave its own base, not from the pickup", async () => {
    // On a load from 08:00 to 12:00.
    const earlier = await bookQuote(quote("2031-03-11", {}, ["08:00", "12:00"]), { vehicleId: east, driverId: null }, null, null);
    expect(earlier.ok).toBe(true);
    // 400 empty miles at the loaded leg's 65 mph is about six hours: leaving around 09:00 for a 15:00 pickup, while still on the first load.
    const far = quote("2031-03-11", { emptyByTruck: { [east]: "400" }, offer: "1501" }, ["15:00", "20:00"]);
    expect(await bookQuote(far, { vehicleId: east, driverId: null }, null, null)).toMatchObject({ ok: false, error: expect.stringMatching(/already on/) });
    const fit = await fitQuote(readQuote(far)!, WS, new Date(), null, 25, [east]);
    expect(fit.rows.find((r) => r.truckId === east)?.blocked).toMatch(/already on/);
    // 40 empty miles: leaving after 14:00, free.
    expect(await bookQuote(quote("2031-03-11", { emptyByTruck: { [east]: "40" }, offer: "1502" }, ["15:00", "20:00"]), { vehicleId: east, driverId: null }, null, null)).toMatchObject({ ok: true });
  });

  test("a card that lapses between the pickup and the last delivery blocks the driver, as assigning does", async () => {
    await prisma.driver.update({ where: { id: eastDriver }, data: { medicalCardExpiry: new Date("2031-03-14T12:00:00Z") } });
    try {
      const v = quote("2031-03-13", {}, ["08:00", "08:00"]);
      v.stops[1]!.appointment = "2031-03-15T08:00";
      const fit = await fitQuote(readQuote(v)!, WS, new Date(), null, 25, [east]);
      const row = fit.rows.find((r) => r.truckId === east && r.driverId === eastDriver);
      expect(row?.blocked).toMatch(/lapses/);
    } finally {
      await prisma.driver.update({ where: { id: eastDriver }, data: { medicalCardExpiry: new Date("2035-01-31T00:00:00Z") } });
    }
  });

  test("a driver short on hours is read from their own clocks, and booking them asks for a reason that goes with the assignment", async () => {
    await prisma.driver.update({ where: { id: tiredDriver }, data: { hosDriveMinutes: 60, hosShiftMinutes: 90, hosCycleMinutes: 600, hosSyncedAt: new Date() } });
    const v = quote("2031-03-17");
    const fit = await fitQuote(readQuote(v)!, WS, new Date(), null, 25, [tiredTruck]);
    const row = fit.rows.find((r) => r.driverId === tiredDriver);
    expect(row?.hos).toMatchObject({ state: "short", needsReason: true, availableHours: 1 });
    expect(await bookQuote(v, { vehicleId: tiredTruck, driverId: tiredDriver }, null, null)).toMatchObject({ ok: false, hos: expect.stringMatching(/drive left/) });
    const ok = await bookQuote(v, { vehicleId: tiredTruck, driverId: tiredDriver }, null, null, WS, new Date(), { hosReason: "Restart ends before pickup" });
    expect(ok).toMatchObject({ ok: true, assigned: true });
    if (ok.ok) {
      const a = await prisma.assignment.findFirstOrThrow({ where: { loadId: ok.loadId } });
      expect(a.driverId).toBe(tiredDriver);
    }
  });

  test("someone who may not see driver pay gets the same verdict with no pay figure", async () => {
    const input = readQuote(quote("2031-03-19"))!;
    const open = await fitQuote(input, WS, new Date(), null, 25, [east]);
    const fenced = await fitQuote(input, WS, new Date(), null, 25, [east], { seesPay: false });
    const a = open.rows.find((r) => r.driverId === eastDriver)!;
    const b = fenced.rows.find((r) => r.driverId === eastDriver)!;
    expect(a.labourNote).toMatch(/\$0\.60/);
    expect(b.labourNote).not.toMatch(/\$|%/);
    expect(b.labourFrom).toBe("driver");
    expect(b.marginPerMile).toBe(a.marginPerMile);
    expect(b.decision).toBe(a.decision);
  });

  test("the lane and customer history follows the terminals in view", async () => {
    const input = readQuote(quote("2031-03-21"))!;
    const all = await quoteContext(input, WS, null);
    const none = await quoteContext(input, WS, "Q1-Nowhere");
    expect(none.broker?.loads ?? 0).toBeLessThanOrEqual(all.broker?.loads ?? 0);
    // Q1 Broker's booked loads sit on Q1 trucks: none of them is in a terminal that holds no trucks.
    expect(all.broker?.loads ?? 0).toBeGreaterThan(none.broker?.loads ?? 0);
  });
});
