import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, floorOffer, readQuote, type QuoteValues } from "@/lib/quote";
import { saveCostProfile, saveTruck } from "@/server/tl/fleet";
import { bookQuote, fitQuote, getQuote, saveQuote, zonedValues } from "@/server/tl/quote";
import { workspaceTimezone } from "@/server/tl/zone";

/**
 * Quote Q2 on the demo database: a time typed for an Atlanta dock is stored as that dock's time and comes back as it was typed, and the counter-offer floor clears the floor when it is
 * priced again. Makes its own truck (named Q2) and removes it afterwards.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const BROKER = "Q2 Broker";

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

describe.skipIf(!run)("Quote Q2 on the demo database", () => {
  const startedAt = new Date();
  let truck = "";

  const quote = (over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: "2031-01-14T08:00" },
      { role: "delivery", address: "Atlanta, GA", appointment: "2031-01-15T08:00" }
    ],
    broker: BROKER,
    offer: "2400",
    loadedMiles: "780",
    loadedHours: "12",
    emptyToPickup: "20",
    emptyHome: "0",
    marketRate: "2400",
    ...over
  });

  beforeAll(async () => {
    const t = await saveTruck({ name: "Q2 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truck = t.id;
    await saveCostProfile(truck, profile);
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: BROKER }, { vehicleId: truck }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }, { createdAt: { gte: startedAt }, summary: { contains: BROKER } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { workspaceId: WS, name: BROKER } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q2 " } } });
  });

  test("08:00 typed for an Atlanta dock is stored as 08:00 Eastern and comes back as typed", async () => {
    // The demo carrier is on Central time; the delivery dock is on Eastern.
    expect(await workspaceTimezone(WS)).toBe("America/Chicago");
    const saved = await saveQuote(quote(), null, truck);
    if (!saved.ok) throw new Error("save");
    const stops = await prisma.stop.findMany({ where: { loadId: saved.id }, orderBy: { stopSequence: "asc" } });
    expect(stops[0]!.timeWindowEarliest!.toISOString()).toBe("2031-01-14T14:00:00.000Z");
    expect(stops[1]!.timeWindowEarliest!.toISOString()).toBe("2031-01-15T13:00:00.000Z");
    const back = await getQuote(saved.id);
    expect(back!.values.stops[1]).toMatchObject({ appointment: "2031-01-15T08:00", zone: "America/New_York" });
    expect(back!.values.stops[0]).toMatchObject({ appointment: "2031-01-14T08:00" });

    const booked = await bookQuote(back!.values, { vehicleId: truck, driverId: null }, null, saved.id, WS, new Date(), { version: back!.version });
    expect(booked.ok).toBe(true);
    const after = await prisma.stop.findMany({ where: { loadId: saved.id }, orderBy: { stopSequence: "asc" } });
    expect(after[1]!.timeWindowEarliest!.toISOString()).toBe("2031-01-15T13:00:00.000Z");
  });

  test("the browser's zone is never taken: a stop sent as Hawaii is still read on its own clock", async () => {
    const v = quote({ offer: "2401" });
    v.stops[1] = { ...v.stops[1]!, zone: "Pacific/Honolulu" };
    const saved = await saveQuote(v, null, truck);
    if (!saved.ok) throw new Error("save");
    const s = await prisma.stop.findFirstOrThrow({ where: { loadId: saved.id, stopSequence: 2 } });
    expect(s.timeWindowEarliest!.toISOString()).toBe("2031-01-15T13:00:00.000Z");
  });

  test("the counter-offer floor, priced again, clears the floor", async () => {
    const short = zonedValues(quote({ offer: "300", fsc: "10", fscUnit: "percent", factoringPct: "3", marketRate: "" }), "America/Chicago");
    const fit = await fitQuote(readQuote(short)!, WS, new Date(), null, 25, [truck]);
    const row = fit.rows.find((r) => r.truckId === truck)!;
    expect(row.marginPerMile!).toBeLessThan(0);
    const floor = floorOffer({ payNeeded: row.detail.payNeeded, gross: row.detail.effectiveGross, marginPerMile: row.marginPerMile, fsc: 10, fscUnit: "percent", loadedMiles: 780 });
    expect(floor).not.toBeNull();
    const again = await fitQuote(readQuote({ ...short, offer: String(floor) })!, WS, new Date(), null, 25, [truck]);
    const at = again.rows.find((r) => r.truckId === truck)!;
    expect(at.marginPerMile!).toBeGreaterThanOrEqual(-0.0001);
    // A dollar under it does not.
    const under = await fitQuote(readQuote({ ...short, offer: String(floor! - 5) })!, WS, new Date(), null, 25, [truck]);
    expect(under.rows.find((r) => r.truckId === truck)!.marginPerMile!).toBeLessThan(0);
  });
});
