import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, quoteCautions, readQuote, type QuoteValues } from "@/lib/quote";
import { AUTHORITY_LABEL, type AuthorityResult, type AuthorityState } from "@/lib/fmcsa";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { bookQuote, fitQuote } from "@/server/tl/quote";

/**
 * Quote, review round five (Q5): the customer's authority is checked at FMCSA when booking (no active authority, or no one with the MC, needs a reason; an outage books with "not checked"
 * on the record), and a hazmat load says what paperwork and endorsement to check.
 */
const answer = (state: AuthorityState, name: string | null = "Q5 Real Brokerage LLC"): ((mc: string) => Promise<AuthorityResult>) => async () => ({ state, label: AUTHORITY_LABEL[state], name, place: null });

describe("hazmat paperwork", () => {
  const base = (over: Partial<QuoteValues> = {}): QuoteValues => ({ ...BLANK_QUOTE, stops: [{ role: "pickup", address: "Dallas, TX", appointment: "" }, { role: "delivery", address: "Tulsa, OK", appointment: "" }], offer: "1500", loadedMiles: "260", ...over });

  test("a hazmat class without the UN number or the emergency phone says what to ask for; with both, nothing", () => {
    expect(quoteCautions(readQuote(base({ hazmatClass: "3" }))!).hazmat).toMatch(/the UN number and the 24-hour emergency phone/);
    expect(quoteCautions(readQuote(base({ hazmatClass: "3", hazmatUnNumber: "UN1203" }))!).hazmat).toMatch(/the 24-hour emergency phone\./);
    expect(quoteCautions(readQuote(base({ hazmatClass: "3", hazmatUnNumber: "UN1203", hazmatEmergencyPhone: "800-424-9300" }))!).hazmat).toBeUndefined();
    expect(quoteCautions(readQuote(base())!).hazmat).toBeUndefined();
  });
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const BROKER = "Q5 Broker";

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

describe.skipIf(!run)("Quote Q5 on the demo database", () => {
  const startedAt = new Date();
  let truck = "";
  let driver = "";

  const quote = (day: string, over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: BROKER,
    brokerMc: "555123",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "20",
    emptyHome: "0",
    marketRate: "1500",
    ...over
  });

  beforeAll(async () => {
    await prisma.customer.create({ data: { workspaceId: WS, name: BROKER, kind: "broker" } }).catch(() => undefined);
    const t = await saveTruck({ name: "Q5 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truck = t.id;
    await saveCostProfile(truck, profile);
    const d = await saveDriver({ name: "Q5 Driver", cdlClass: "A", cdlExpiry: "2035-01-31", medicalCardExpiry: "2035-01-31", assignedVehicleId: truck, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driver = d.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ vehicleId: truck }, { brokerName: BROKER }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.assignment.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { workspaceId: WS, name: BROKER } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q5 " } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q5 " } } });
  });

  const bookedAudit = async (loadId: string) => (await prisma.auditEvent.findFirstOrThrow({ where: { loadId, action: "booked" } })).after as Record<string, unknown>;

  test("no active authority needs a reason, and the reason goes on the record", async () => {
    const asked = await bookQuote(quote("2031-05-01"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("inactive") });
    expect(asked).toMatchObject({ ok: false, authority: { mc: "555123", state: "inactive", name: "Q5 Real Brokerage LLC" } });
    const notFound = await bookQuote(quote("2031-05-01"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("not_found", null) });
    expect(notFound).toMatchObject({ ok: false, authority: { state: "not_found" } });

    const booked = await bookQuote(quote("2031-05-01"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("inactive"), authorityReason: "Reinstated today, confirmed by phone" });
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    expect(String((await bookedAudit(booked.loadId))["Customer authority"])).toMatch(/no active authority.*booked anyway: Reinstated today/i);
  });

  test("active broker authority books with no question and is on the record", async () => {
    const booked = await bookQuote(quote("2031-05-02"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("broker") });
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    expect((await bookedAudit(booked.loadId))["Customer authority"]).toBe("Broker authority active (Q5 Real Brokerage LLC)");
  });

  test("FMCSA not answering books, with 'not checked' and the person's own SAFER check on the record", async () => {
    const booked = await bookQuote(quote("2031-05-03"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("unavailable", null), saferChecked: true });
    if (!booked.ok) throw new Error(JSON.stringify(booked));
    expect((await bookedAudit(booked.loadId))["Customer authority"]).toBe("Not checked (FMCSA did not answer); checked on SAFER by hand");
  });

  test("carrier authority only is said after booking, not asked about", async () => {
    const booked = await bookQuote(quote("2031-05-04"), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: answer("carrier") });
    expect(booked).toMatchObject({ ok: true, note: expect.stringMatching(/carrier authority only, not broker authority/) });
  });

  test("a shipper with no MC is not looked up at all", async () => {
    let asked = 0;
    const booked = await bookQuote(quote("2031-05-05", { brokerMc: "" }), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { authorityLookup: async (mc) => (asked++, answer("inactive")(mc)) });
    expect(booked.ok).toBe(true);
    expect(asked).toBe(0);
  });

  test("a hazmat load says each driver's H endorsement is not on file", async () => {
    const fit = await fitQuote(readQuote(quote("2031-05-06", { hazmatClass: "3" }))!, WS, new Date(), null, 25, [truck]);
    const row = fit.rows.find((r) => r.driverId === driver)!;
    expect(row.warnings.join(" ")).toMatch(/Q5 Driver's H endorsement is not on file/);
    const plain = await fitQuote(readQuote(quote("2031-05-06"))!, WS, new Date(), null, 25, [truck]);
    expect(plain.rows.find((r) => r.driverId === driver)!.warnings.join(" ")).not.toMatch(/endorsement/);
  });
});
