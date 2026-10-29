import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote, validateQuote, type QuoteValues } from "@/lib/quote";
import { saveCostProfile, saveTruck } from "@/server/tl/fleet";
import { bookQuote, fitQuote, getQuote, saveQuote } from "@/server/tl/quote";
import { num } from "@/server/tl/convert";
import { normalizeExtraction } from "@/truelane/rate-con/core";
import { DEMO_RATE_CON_READINGS } from "@/server/ratecon/fixtures";
import { extractionToLoadDraft } from "@/server/ratecon/map";
import { saveReviewedDraft } from "@/server/ratecon/save";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own trucks and loads (all named WB2) and removes them and their
 * audit events afterwards. No outside service is reached.
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

describe.skipIf(!run)("fuel price for one price check, on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  let diesel = "";
  let gas = "";

  const day = "2027-05-11";
  const quote = (over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: "WB2 Customer",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });
  const left = async (v: QuoteValues, truckId: string) => {
    const input = readQuote(v);
    if (!input) throw new Error("not priceable");
    const fit = await fitQuote(input);
    return fit.rows.find((r) => r.truckId === truckId)!.leftOver!;
  };

  beforeAll(async () => {
    const d = await saveTruck({ name: "WB2 Diesel", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const g = await saveTruck({ name: "WB2 Gas", type: "box_truck", mpg: "10", fuelType: "gasoline" }, null);
    if (!d.ok || !g.ok) throw new Error("trucks");
    diesel = d.id;
    gas = g.id;
    if (!(await saveCostProfile(diesel, profile)).ok || !(await saveCostProfile(gas, profile)).ok) throw new Error("profiles");
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: "WB2 Customer" }, { id: { in: loadIds } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WB2" } } });
  });

  test("a typed fuel price replaces the truck's own on a diesel truck for that check, and leaves a gasoline truck alone", async () => {
    const own = await left(quote(), diesel);
    const dear = await left(quote({ fuelPrice: "7" }), diesel); // $7 against the profile's $3.90
    const cheap = await left(quote({ fuelPrice: "2" }), diesel);
    expect(dear).toBeLessThan(own);
    expect(cheap).toBeGreaterThan(own);
    // 540 miles at 10 mpg is 54 gallons: each extra dollar a gallon takes about $54 off what is left.
    expect(own - dear).toBeGreaterThan(150);
    expect(own - dear).toBeLessThan(180);

    expect(await left(quote({ fuelPrice: "7" }), gas)).toBeCloseTo(await left(quote(), gas), 6);
  });

  test("is checked, and not kept: a saved quote reopens on each truck's own price, and a booked load carries no fuel price of its own", async () => {
    expect(validateQuote(quote({ fuelPrice: "0.1" }))).toMatchObject({ ok: false, errors: { fuelPrice: expect.any(String) } });
    expect(validateQuote(quote({ fuelPrice: "abc" }))).toMatchObject({ ok: false, errors: { fuelPrice: expect.any(String) } });
    expect(validateQuote(quote({ fuelPrice: "30" })).ok).toBe(false);
    expect(validateQuote(quote({ fuelPrice: "5.25" })).ok).toBe(true);

    const saved = await saveQuote(quote({ fuelPrice: "7" }), null, diesel);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect((await getQuote(saved.id))!.values.fuelPrice).toBe("");

    const booked = await bookQuote(quote({ fuelPrice: "7" }), { vehicleId: diesel, driverId: null }, null, null);
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    loadIds.push(booked.loadId);
    const profileRow = await prisma.costProfile.findUniqueOrThrow({ where: { vehicleId: diesel } });
    expect(num(profileRow.lastFuelPricePerGallon)).toBe(3.9); // the truck's own price is untouched
  });
});

describe.skipIf(!run)("a rate confirmation across time zones, saved as a load", () => {
  const startedAt = new Date();

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, brokerName: "WB2 Customer" }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "intake" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
  });

  test("keeps each stop's time as the instant it means there, the measured miles, and the MC as digits only", async () => {
    const draft = extractionToLoadDraft(normalizeExtraction(DEMO_RATE_CON_READINGS["RC-SLG-55102"]!));
    if (!draft) throw new Error("draft");
    draft.load.brokerName = "WB2 Customer";
    draft.load.brokerMcNumber = "MC 1515";
    draft.load.loadedMiles = 1396.7; // what the review measured, there being none printed
    const saved = await saveReviewedDraft({ ...draft, confirmed: true });
    const row = await prisma.load.findUniqueOrThrow({ where: { id: saved.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
    expect(row.brokerMcNumber).toBe("1515");
    expect(num(row.loadedMiles)).toBe(1396.7);
    expect(row.stops.map((s) => [s.timeWindowEarliest?.toISOString(), s.timeWindowLatest?.toISOString()])).toEqual([
      ["2027-03-16T12:00:00.000Z", "2027-03-16T12:00:00.000Z"], // 8:00 AM EDT
      ["2027-03-18T19:00:00.000Z", "2027-03-18T22:00:00.000Z"] // 1:00 to 4:00 PM MDT
    ]);
  });
});
