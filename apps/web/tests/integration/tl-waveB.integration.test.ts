import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote, type QuoteValues } from "@/lib/quote";
import { saveStopCoordinates } from "@/server/geo/persist";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { bookQuote, fitQuote, getQuote, saveQuote } from "@/server/tl/quote";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own truck, driver and loads (all named WB) and removes them and
 * their audit events afterwards. Mapbox is never reached: fetch is replaced, so the permanent geocoder answers from a table here.
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

const feature = (text: string, state: string, lng: number, lat: number) => ({ features: [{ text, place_type: ["place"], center: [lng, lat], context: [{ id: "region.1", text: state, short_code: `US-${state}` }] }] });

describe.skipIf(!run)("measured miles and stored coordinates on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  const original = process.env.MAPBOX_ACCESS_TOKEN;
  let truckId = "";
  let driverId = "";
  const urls: string[] = [];

  const day = "2027-03-02";
  const quote = (over: Partial<QuoteValues> = {}): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: "WB Broker",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });

  beforeAll(async () => {
    const t = await saveTruck({ name: "WB Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    const p = await saveCostProfile(truckId, profile);
    if (!p.ok) throw new Error("profile");
    const d = await saveDriver({ name: "WB Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: truckId, payKind: "hourly", payRate: "30" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = original;
    urls.length = 0;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, OR: [{ brokerName: "WB Broker" }, { id: { in: loadIds } }] }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WB" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WB" } } });
  });

  const stubMapbox = () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes("Dallas") ? feature("Dallas", "TX", -96.797, 32.7767) : url.includes("Tulsa") ? feature("Tulsa", "OK", -95.9928, 36.154) : { features: [] };
        return { ok: true, json: async () => body };
      })
    );
  };

  test("a booked load takes the permanent coordinates of every stop, to six places, and a second pass changes nothing", async () => {
    stubMapbox();
    const out = await bookQuote(quote(), { vehicleId: truckId, driverId: null }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    const stops = await prisma.stop.findMany({ where: { loadId: out.loadId }, orderBy: { stopSequence: "asc" } });
    expect(stops.map((s) => [num(s.lat as never), num(s.lng as never)])).toEqual([
      [32.7767, -96.797],
      [36.154, -95.9928]
    ]);
    expect(urls.every((u) => u.includes("mapbox.places-permanent"))).toBe(true);
    const before = urls.length;
    expect(await saveStopCoordinates(out.loadId)).toBe(0);
    expect(urls.length).toBe(before); // stops that have coordinates are not looked up again
  });

  test("with no Mapbox key a stop simply keeps no coordinates, and the save is not affected", async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    const out = await bookQuote(quote({ broker: "WB Broker" }), { vehicleId: truckId, driverId: null }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    const stops = await prisma.stop.findMany({ where: { loadId: out.loadId } });
    expect(stops.every((s) => s.lat == null && s.lng == null)).toBe(true);
  });

  test("measured hours are stored with the quote, come back when it is reopened, and are the speed an hourly driver is costed at", async () => {
    const withHours = quote({ loadedHours: "4" }); // 260 loaded miles in 4 h: 65 mph
    const saved = await saveQuote(withHours, null, truckId);
    if (!saved.ok) throw new Error("save");
    loadIds.push(saved.id);
    expect(num((await prisma.load.findUniqueOrThrow({ where: { id: saved.id } })).estimatedLoadedHours as never)).toBe(4);
    expect((await getQuote(saved.id))!.values.loadedHours).toBe("4");

    const flat = readQuote(quote());
    const measured = readQuote(withHours);
    if (!flat || !measured) throw new Error("not priceable");
    const pick = (fit: Awaited<ReturnType<typeof fitQuote>>) => fit.rows.find((r) => r.truckId === truckId && r.driverId === driverId)!;
    const slow = pick(await fitQuote(flat)); // no measured hours: 540 miles at 50 mph is 10.8 h
    const quick = pick(await fitQuote(measured)); // 4 h for 260 miles spread over 540 miles is 8.3 h
    // Fewer hours at $30 an hour is less labour, so more is left over.
    expect(quick.leftOver!).toBeGreaterThan(slow.leftOver!);
  });

  test("a booked load carries its own truck's empty miles, not the shared figure", async () => {
    const out = await bookQuote(quote({ emptyByTruck: { [truckId]: "75" }, emptyHomeByTruck: { [truckId]: "90" }, broker: "WB Broker" }), { vehicleId: truckId, driverId: null }, null, null);
    if (!out.ok) throw new Error(JSON.stringify(out));
    loadIds.push(out.loadId);
    const l = await prisma.load.findUniqueOrThrow({ where: { id: out.loadId } });
    expect(num(l.pickupDeadheadMiles as never)).toBe(75);
    expect(num(l.returnDeadheadMiles as never)).toBe(90);
  });
});
