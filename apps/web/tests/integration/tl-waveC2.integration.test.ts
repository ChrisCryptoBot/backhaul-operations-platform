import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver } from "@/server/tl/dispatch";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { assignFromQueue, assignOptions } from "@/server/tl/suggest";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own trucks, drivers and loads (all named WC2) and removes them and
 * their audit events afterwards. Every load that gets a driver has its own day so the double-booking guard never gets in the way unless asked.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const at = (local: string) => new Date(`${local}:00-05:00`);

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
  archetype: "hired_driver",
  payKind: "cpm",
  hiredDriverRatePerMile: "0.55",
  laborBurdenPct: "18"
};
const driverForm = (name: string, over: Record<string, unknown> = {}) => ({ name, cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", ...over });

describe.skipIf(!run)("who could take a load, on the demo database", () => {
  const startedAt = new Date();
  const ids: Record<string, string> = {};

  const mkLoad = (n: string, day: string, over: Record<string, unknown> = {}) =>
    prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `WC2-${n}`,
        brokerName: "WC2 Customer",
        vehicleId: ids.truck,
        status: "draft",
        quotedRevenue: 1500,
        loadedMiles: 260,
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
      }
    });

  beforeAll(async () => {
    const t = await saveTruck({ name: "WC2 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    const other = await saveTruck({ name: "WC2 Other Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok || !other.ok) throw new Error("trucks");
    ids.truck = t.id;
    ids.other = other.id;
    if (!(await saveCostProfile(t.id, profile)).ok || !(await saveCostProfile(other.id, profile)).ok) throw new Error("profiles");
    const make = async (key: string, over: Record<string, unknown>) => {
      const d = await saveDriver(driverForm(`WC2 ${key}`, over), null);
      if (!d.ok) throw new Error(`driver ${key}`);
      ids[key] = d.id;
    };
    await make("Cheap", { assignedVehicleId: t.id, payKind: "cpm", payRate: "0.40" });
    await make("Dear", { assignedVehicleId: t.id, payKind: "cpm", payRate: "0.80" });
    await make("Lapsed", { assignedVehicleId: t.id, cdlExpiry: "2020-01-31", payKind: "cpm", payRate: "0.30" });
    await make("Busy", { assignedVehicleId: t.id, payKind: "cpm", payRate: "0.35" });
    await make("Loose", {}); // no truck, no usual pay
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, brokerName: "WC2 Customer" }, select: { id: true } });
    const loadIds = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: loadIds } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC2" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC2" } } });
  });

  test("lists every active driver with what stops them, and suggests the best fits first: the cheapest usual pay leaves the most over the floor", async () => {
    const day = "2027-06-07";
    const busyWith = await mkLoad("BUSY", day);
    await assignDriver({ loadId: busyWith.id, driverId: ids.Busy!, pay: { kind: "cpm", rate: 0.35 } });
    const load = await mkLoad("OPEN", day);

    const out = (await assignOptions(load.id, undefined, { limit: 50 }))!; // the demo drivers are in the ranking too: look at the whole of it
    expect(out).toMatchObject({ loadNumber: "WC2-OPEN", lane: "Dallas, TX → Tulsa, OK", hasTruck: true, rateConTotal: 1500 });
    const by = Object.fromEntries(out.drivers.map((d) => [d.name, d]));
    expect(by["WC2 Lapsed"]!.blocker).toEqual(expect.stringContaining("CDL"));
    expect(by["WC2 Busy"]!.busy).toEqual(expect.stringContaining("WC2-BUSY"));
    expect(by["WC2 Cheap"]).toMatchObject({ blocker: null, busy: null, payKind: "cpm", payRate: 0.4 });

    const names = out.suggestions.map((s) => s.name).filter((n) => n.startsWith("WC2"));
    expect(names).toEqual(["WC2 Cheap", "WC2 Dear", "WC2 Loose"].filter((n) => names.includes(n)).sort((a, b) => names.indexOf(a) - names.indexOf(b)));
    expect(names.indexOf("WC2 Cheap")).toBeLessThan(names.indexOf("WC2 Dear"));
    expect(names).not.toContain("WC2 Lapsed"); // cannot take it
    expect(names).not.toContain("WC2 Busy"); // already on a load then
    const cheap = out.suggestions.find((s) => s.name === "WC2 Cheap")!;
    const dear = out.suggestions.find((s) => s.name === "WC2 Dear")!;
    expect(cheap.leftOver!).toBeGreaterThan(dear.leftOver!);
    // 280 miles at $0.40 against $0.80 a mile, plus the payroll burden on it.
    expect(cheap.leftOver! - dear.leftOver!).toBeGreaterThan(100);
    expect(cheap).toMatchObject({ truckName: "WC2 Truck", onLoadsTruck: true });
  });

  test("a driver with no usual pay and no truck is still offered, last when the load cannot be priced on them", async () => {
    const load = await mkLoad("NOTRUCK", "2027-06-09", { vehicleId: null });
    const out = (await assignOptions(load.id, undefined, { limit: 50 }))!;
    expect(out.hasTruck).toBe(false);
    // Without a truck on the load, a driver is priced on the truck they usually drive; this one drives none, so there is no price, and it goes last.
    const loose = out.suggestions.find((s) => s.name === "WC2 Loose")!;
    expect(loose.leftOver).toBeNull();
    expect(out.suggestions[out.suggestions.length - 1]!.name).toBe("WC2 Loose");
    expect((await assignOptions(load.id))!.suggestions.length).toBeLessThanOrEqual(3); // the window shows three
    expect(await assignOptions("no-such-load")).toBeNull();
  });

  test("assigning from the queue answers in place: it assigns, says what is wrong, and wants a reason to double-book", async () => {
    const day = "2027-06-14";
    const first = await mkLoad("Q1", day);
    const second = await mkLoad("Q2", day);
    expect(await assignFromQueue({ loadId: first.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" })).toEqual({ ok: true });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: first.id } })).driverId).toBe(ids.Cheap);

    const clash = await assignFromQueue({ loadId: second.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" });
    expect(clash).toMatchObject({ ok: false, error: expect.stringContaining("already on WC2-Q1") });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40", overrideReason: "Two short hops, same dock" })).toEqual({ ok: true });

    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Lapsed!, payKind: "cpm", rate: "0.40" })).toMatchObject({ ok: false, error: expect.stringContaining("CDL") });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "cpm", rate: "abc" })).toEqual({ ok: false, error: "Type the pay rate, above zero." });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "percent", rate: "100" })).toMatchObject({ ok: false });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "percent", rate: "25" })).toEqual({ ok: true });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: second.id } })).payKind).toBe("percent");
  });
});
