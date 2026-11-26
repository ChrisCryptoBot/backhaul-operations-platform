import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, type QuoteValues } from "@/lib/quote";
import { nearNames } from "@/lib/customer-match";
import { fuelBasisOf } from "@/server/tl/evaluate";
import { saveCostProfile, saveTruck } from "@/server/tl/fleet";
import { bookQuote } from "@/server/tl/quote";
import { listQuoteDecisions } from "@/server/tl/quote-report";
import { getLoadDetail } from "@/server/tl/queries";

/**
 * Quote, review round three (Q3): who decided is kept by an id as well as a name; a booked load is judged on the fuel price it was quoted on until its receipts come in; a new customer is
 * asked about before Quote makes one, with the close spellings already on the desk.
 */
describe("close spellings of a customer", () => {
  const known = ["XPO Logistics", "Coyote Logistics", "Echo Global Logistics", "TQL", "Arrive Logistics"];

  test("a typo, a missing ending or a short form finds the customer; an unrelated name finds nothing", () => {
    expect(nearNames("XPO Logistcs", known)[0]).toBe("XPO Logistics");
    expect(nearNames("XPO Logistics, Inc.", known)[0]).toBe("XPO Logistics");
    expect(nearNames("Coyote", known)).toContain("Coyote Logistics");
    expect(nearNames("Mountain Express Carriers", known)).toEqual([]);
    // The very same name is the same record, not a suggestion.
    expect(nearNames("xpo logistics", known)).not.toContain("XPO Logistics");
  });
});

describe("the fuel price a booked load is judged on", () => {
  const profile = { lastFuelPricePerGallon: 4.1 };

  test("receipts first (gallon for gallon), then the price it was quoted on, then the truck's own", () => {
    const receipts = [
      { gallons: 100, pricePerGallon: 3.5, amount: 350 },
      { gallons: 50, pricePerGallon: null, amount: 200 } // $4.00 a gallon, from the amount
    ];
    expect(fuelBasisOf({ quoteExtras: { fuelPrice: 3.2 }, fuelTransactions: receipts }, profile, { fuelType: "diesel" })).toEqual({ price: 550 / 150, source: "receipts" });
    expect(fuelBasisOf({ quoteExtras: { fuelPrice: 3.2 }, fuelTransactions: [] }, profile, { fuelType: "diesel" })).toEqual({ price: 3.2, source: "quote" });
    expect(fuelBasisOf({ quoteExtras: null }, profile, { fuelType: "diesel" })).toEqual({ price: 4.1, source: "truck" });
  });

  test("a truck known to burn something else keeps its own price, and a nonsense figure is ignored", () => {
    expect(fuelBasisOf({ quoteExtras: { fuelPrice: 3.2 } }, profile, { fuelType: "gasoline" }).source).toBe("truck");
    expect(fuelBasisOf({ quoteExtras: { fuelPrice: 320 } }, profile, null).source).toBe("truck");
    expect(fuelBasisOf({ fuelTransactions: [{ gallons: 0, pricePerGallon: 3, amount: 0 }] }, profile, null).source).toBe("truck");
  });
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";

const truckProfile: Record<string, string> = {
  monthlyInsurance: "800",
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "4.10",
  driverHourlyTarget: "25",
  archetype: "solo_owner"
};

describe.skipIf(!run)("Quote Q3 on the demo database", () => {
  const startedAt = new Date();
  let truck = "";
  const NEW_NAME = "Q3 Brand New Freight";
  const KNOWN = "Q3 Known Logistics";

  const quote = (day: string, over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: KNOWN,
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "20",
    emptyHome: "0",
    marketRate: "1500",
    ...over
  });

  beforeAll(async () => {
    const t = await saveTruck({ name: "Q3 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truck = t.id;
    await saveCostProfile(truck, truckProfile);
    await prisma.customer.create({ data: { workspaceId: WS, name: KNOWN, kind: "broker", mcNumber: "765432" } });
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ vehicleId: truck }, { brokerName: { startsWith: "Q3 " } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.fuelTransaction.deleteMany({ where: { workspaceId: WS, provider: "q3-test" } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: { in: ["fleet", "customer"] } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q3 " } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "Q3 " } } });
  });

  test("a new customer is asked about first, with the close spellings; then made as that kind and put on the trail", async () => {
    const typo = await bookQuote(quote("2031-04-01", { broker: "Q3 Known Logistcs" }), { vehicleId: truck, driverId: null }, null, null);
    expect(typo).toMatchObject({ ok: false, newCustomer: { name: "Q3 Known Logistcs", near: [KNOWN] } });

    const asked = await bookQuote(quote("2031-04-02", { broker: NEW_NAME }), { vehicleId: truck, driverId: null }, null, null);
    expect(asked).toMatchObject({ ok: false, newCustomer: { name: NEW_NAME } });
    expect(await prisma.customer.count({ where: { workspaceId: WS, name: NEW_NAME } })).toBe(0);

    const booked = await bookQuote(quote("2031-04-02", { broker: NEW_NAME }), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { customerKind: "shipper" });
    expect(booked.ok).toBe(true);
    expect(await prisma.customer.findFirstOrThrow({ where: { workspaceId: WS, name: NEW_NAME } })).toMatchObject({ kind: "shipper" });
    const trail = await prisma.auditEvent.findFirst({ where: { workspaceId: WS, entity: "customer", action: "customer_added", summary: { contains: NEW_NAME } } });
    expect(trail?.summary).toMatch(/shipper or direct customer while booking a quote/i);
  });

  test("an MC already on another customer's record is a caution after booking, not a refusal", async () => {
    const out = await bookQuote(quote("2031-04-03", { broker: "Q3 Other Name", brokerMc: "765432" }), { vehicleId: truck, driverId: null }, null, null, WS, new Date(), { customerKind: "broker" });
    expect(out).toMatchObject({ ok: true, note: expect.stringMatching(/MC 765432 is also on Q3 Known Logistics/) });
  });

  test("the booked load is judged on its quoted fuel price until its receipts come in", async () => {
    const out = await bookQuote(quote("2031-04-04", { fuelPrice: "3.20", fuelSource: "regional" }), { vehicleId: truck, driverId: null }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    const before = await getLoadDetail(out.loadId, WS, null);
    expect(before!.evaluation!.fuelBasis).toEqual({ price: 3.2, source: "quote" });
    await prisma.fuelTransaction.create({ data: { workspaceId: WS, provider: "q3-test", externalId: `q3-${out.loadId}`, loadId: out.loadId, vehicleId: truck, postedAt: new Date(), product: "road_diesel", gallons: 40, pricePerGallon: 3.75, amount: 150 } });
    const after = await getLoadDetail(out.loadId, WS, null);
    expect(after!.evaluation!.fuelBasis).toEqual({ price: 3.75, source: "receipts" });
    // The cost moved with it: dearer fuel than quoted, less left over.
    expect(after!.evaluation!.result.verdictMarginPerMi!).toBeLessThan(before!.evaluation!.result.verdictMarginPerMi!);
  });

  test("a dispatcher's own decisions are found by their id, and by name only for decisions from before ids were kept", async () => {
    const out = await bookQuote(quote("2031-04-05"), { vehicleId: truck, driverId: null }, null, null);
    if (!out.ok) throw new Error("book");
    const load = out.loadId;
    const at = new Date();
    const mk = (decidedBy: string, decidedById: string | null) => prisma.loadDecision.create({ data: { loadId: load, decisionType: "passed", overrideReason: "Rate too low", decidedBy, decidedById, decidedAt: at } });
    const mine = await mk("Sam", "user_sam_1");
    const namesake = await mk("Sam", "user_sam_2");
    const legacy = await mk("Sam", null);
    const { rows } = await listQuoteDecisions({ period: "all", by: { id: "user_sam_1", name: "Sam" } });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(mine.id)).toBe(true);
    expect(ids.has(legacy.id)).toBe(true);
    expect(ids.has(namesake.id)).toBe(false);
  });
});
