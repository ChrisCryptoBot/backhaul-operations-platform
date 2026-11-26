import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, recordDriverResponse } from "@/server/tl/dispatch";
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

  test("a person limited to other terminals cannot read a load placed outside them; a load placed nowhere is everyone's", async () => {
    const placed = await mkLoad("FENCE", "2027-06-10"); // on the WC2 truck, which is in no terminal the limit names
    const loose = await mkLoad("FENCE-LOOSE", "2027-06-11", { vehicleId: null });
    expect(await assignOptions(placed.id, undefined, { allowed: "WC2 Elsewhere" })).toBeNull();
    expect(await assignOptions(placed.id, undefined, { allowed: null })).not.toBeNull();
    expect(await assignOptions(loose.id, undefined, { allowed: "WC2 Elsewhere" })).not.toBeNull();
  });

  test("a driver has to be cleared for the whole trip: a card that lapses mid-trip, or a failed carrier check, blocks", async () => {
    // Made here and taken out of service at the end, so they never show in the other tests' rankings.
    const mid = await saveDriver(driverForm("WC2 Midtrip", { medicalCardExpiry: "2027-06-16", payKind: "cpm", payRate: "0.40" }), null); // good through the 16th
    const failed = await saveDriver(driverForm("WC2 Failed", { payKind: "cpm", payRate: "0.40" }), null);
    if (!mid.ok || !failed.ok) throw new Error("drivers");
    await prisma.driver.update({ where: { id: failed.id }, data: { vetStatus: "failed" } });
    try {
      // A two-day trip: picked up on the 16th, delivered on the 17th, after the card has lapsed.
      const lapsesDuring = await mkLoad("MID1", "2027-06-16", {
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: at("2027-06-16T08:00"), timeWindowLatest: at("2027-06-16T09:00") },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: at("2027-06-17T16:00"), timeWindowLatest: at("2027-06-17T17:00") }
          ]
        }
      });
      const overBefore = await mkLoad("MID2", "2027-06-15");
      expect(await assignFromQueue({ loadId: lapsesDuring.id, driverId: mid.id, payKind: "cpm", rate: "0.40" })).toMatchObject({ ok: false, error: expect.stringContaining("Medical card lapses") });
      // The Assign window says the same before anyone presses Assign.
      const out = (await assignOptions(lapsesDuring.id, undefined, { limit: 50 }))!;
      expect(out.drivers.find((d) => d.name === "WC2 Midtrip")?.blocker).toMatch(/^Medical card lapses/);
      expect(await assignFromQueue({ loadId: overBefore.id, driverId: mid.id, payKind: "cpm", rate: "0.40" })).toEqual({ ok: true });
      const other = await mkLoad("MID3", "2027-06-18", { vehicleId: ids.other });
      expect(await assignFromQueue({ loadId: other.id, driverId: failed.id, payKind: "cpm", rate: "0.40" })).toMatchObject({ ok: false, error: expect.stringContaining("Failed the carrier check") });
    } finally {
      await prisma.driver.updateMany({ where: { id: { in: [mid.id, failed.id] } }, data: { active: false } });
    }
  });

  test("each condition needs its own reason: a reason for changing the driver does not double-book them", async () => {
    const day = "2027-06-21";
    const held = await mkLoad("R1", day);
    const elsewhere = await mkLoad("R2", day, { vehicleId: ids.other });
    expect(await assignFromQueue({ loadId: held.id, driverId: ids.Dear!, payKind: "cpm", rate: "0.80" })).toEqual({ ok: true });
    await dispatchLoad(held.id);
    expect(await assignFromQueue({ loadId: elsewhere.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" })).toEqual({ ok: true });
    // Cheap is on R2 at the same time, and Dear has R1: both need a reason, and the window is told both at once.
    const both = await assignFromQueue({ loadId: held.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" });
    expect(both).toMatchObject({ ok: false, code: "reasons_needed" });
    expect((both as { needs: Array<{ code: string }> }).needs.map((n) => n.code).sort()).toEqual(["double_booked", "reason_required"]);
    const one = await assignFromQueue({ loadId: held.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40", reasons: { reason_required: "Dear called in sick" } });
    expect((one as { needs: Array<{ code: string }> }).needs.map((n) => n.code)).toEqual(["double_booked"]);
    expect(await assignFromQueue({ loadId: held.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40", reasons: { reason_required: "Dear called in sick", double_booked: "R2 is a short hop first" } })).toEqual({ ok: true });
    const audit = await prisma.auditEvent.findFirst({ where: { loadId: held.id, action: "reassigned" }, orderBy: { createdAt: "desc" } });
    expect(audit?.reason).toBe("Double-booked: R2 is a short hop first; Driver changed: Dear called in sick");
  });

  test("a load with no truck takes the driver's truck; a truck already on another load then needs its own reason", async () => {
    const day = "2027-06-24";
    const loose = await mkLoad("TRK1", day, { vehicleId: null });
    expect(await assignFromQueue({ loadId: loose.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" })).toEqual({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loose.id } })).vehicleId).toBe(ids.truck);
    const said = await prisma.auditEvent.findFirst({ where: { loadId: loose.id, action: "assigned" }, orderBy: { createdAt: "desc" } });
    expect(said?.summary).toContain("on WC2 Truck");

    // The WC2 truck is now on TRK1 that day: Dear, who usually drives it, is free, but the truck is not.
    const second = await mkLoad("TRK2", day, { vehicleId: null });
    const busy = await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "cpm", rate: "0.80" });
    expect(busy).toMatchObject({ ok: false, code: "reasons_needed" });
    expect((busy as { needs: Array<{ code: string }> }).needs.map((n) => n.code)).toEqual(["truck_busy"]);
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "cpm", rate: "0.80", reasons: { truck_busy: "TRK1 is done by noon" } })).toEqual({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: second.id } })).vehicleId).toBe(ids.truck);
  });

  test("someone who may not see driver pay assigns at the driver's usual pay, never a typed one, and sees no pay or margin", async () => {
    const load = await mkLoad("PAY1", "2027-06-25");
    const hidden = (await assignOptions(load.id, undefined, { limit: 50, seesPay: false }))!;
    expect(hidden.seesPay).toBe(false);
    expect(hidden.rateConTotal).toBe(0);
    expect(hidden.drivers.every((d) => d.payKind == null && d.payRate == null)).toBe(true);
    expect(hidden.suggestions.every((s) => s.leftOver == null && s.payRate == null)).toBe(true);
    expect(hidden.drivers.find((d) => d.name === "WC2 Loose")?.noUsualPay).toBe(true);

    // A typed 9.99 a mile is ignored: Cheap's usual $0.40 a mile is what is saved.
    expect(await assignFromQueue({ loadId: load.id, driverId: ids.Cheap!, payKind: "cpm", rate: "9.99" }, { usualPayOnly: true })).toEqual({ ok: true });
    expect(Number((await prisma.assignment.findUniqueOrThrow({ where: { loadId: load.id } })).payRate)).toBe(0.4);

    const other = await mkLoad("PAY2", "2027-06-26", { vehicleId: ids.other });
    expect(await assignFromQueue({ loadId: other.id, driverId: ids.Loose!, payKind: "cpm", rate: "0.50" }, { usualPayOnly: true })).toEqual({ ok: false, code: "no_default_pay", error: "WC2 Loose has no usual pay set. Ask billing or an admin to set it on their driver page." });
  });

  test("hours: a driver short on hours is cautioned, left out of the best fits, and assigned only with a reason of its own", async () => {
    const tired = await saveDriver(driverForm("WC2 Tired", { payKind: "cpm", payRate: "0.40" }), null);
    if (!tired.ok) throw new Error("driver");
    await prisma.driver.update({ where: { id: tired.id }, data: { hosDriveMinutes: 120, hosShiftMinutes: 300, hosCycleMinutes: 2000, hosSyncedAt: new Date() } });
    try {
      const load = await mkLoad("HOS1", "2027-06-28", { vehicleId: ids.other });
      const out = (await assignOptions(load.id, undefined, { limit: 50 }))!;
      const opt = out.drivers.find((d) => d.name === "WC2 Tired")!;
      expect(opt.hosState).toBe("short");
      expect(opt.hosNote).toMatch(/^2\.0 h drive left · trip needs ~/);
      expect(out.suggestions.some((s) => s.name === "WC2 Tired")).toBe(false);
      const refused = await assignFromQueue({ loadId: load.id, driverId: tired.id, payKind: "cpm", rate: "0.40" });
      expect((refused as { needs?: Array<{ code: string }> }).needs?.map((n) => n.code)).toEqual(["hos_short"]);
      expect(await assignFromQueue({ loadId: load.id, driverId: tired.id, payKind: "cpm", rate: "0.40", reasons: { hos_short: "10 h reset before the 06:00 pickup" } })).toEqual({ ok: true });
      const audit = await prisma.auditEvent.findFirst({ where: { loadId: load.id, action: "assigned" }, orderBy: { createdAt: "desc" } });
      expect(audit?.reason).toBe("Short on hours: 10 h reset before the 06:00 pickup");
    } finally {
      await prisma.driver.update({ where: { id: tired.id }, data: { active: false } });
    }
  });

  test("on a load with no truck, a driver whose truck is on another load then is not a best fit, and says why", async () => {
    const day = "2027-06-29";
    await mkLoad("BUSYTRK", day); // the WC2 truck is on this one that day
    const loose = await mkLoad("TRK3", day, { vehicleId: null });
    const out = (await assignOptions(loose.id, undefined, { limit: 50 }))!;
    const dear = out.drivers.find((d) => d.name === "WC2 Dear")!;
    expect(dear.truckNote).toBe("WC2 Truck is on WC2-BUSYTRK");
    expect(out.suggestions.some((s) => s.name === "WC2 Dear")).toBe(false);
  });

  test("a driver who declined a load is not suggested for it again, and goes to the end of its list", async () => {
    const load = await mkLoad("DECL1", "2027-06-30");
    expect(await assignFromQueue({ loadId: load.id, driverId: ids.Dear!, payKind: "cpm", rate: "0.80" })).toEqual({ ok: true });
    await dispatchLoad(load.id);
    await recordDriverResponse(load.id, "declined", new Date(), "Home time");
    const out = (await assignOptions(load.id, undefined, { limit: 50 }))!;
    expect(out.drivers.find((d) => d.name === "WC2 Dear")?.thisLoad).toBe("Declined this load");
    expect(out.suggestions.some((s) => s.name === "WC2 Dear")).toBe(false);
    expect(out.drivers[out.drivers.length - 1]!.name).toBe("WC2 Dear");
  });

  test("send checks the load again inside its own transaction: a load that moved on since it was assigned is not sent", async () => {
    const load = await mkLoad("SEND-MOVED", "2027-06-23");
    expect(await assignFromQueue({ loadId: load.id, driverId: ids.Dear!, payKind: "cpm", rate: "0.80" })).toEqual({ ok: true });
    // Something else moved the load on after the assignment was saved (the same window a delete would land in).
    await prisma.load.update({ where: { id: load.id }, data: { status: "in_progress" } });
    await expect(dispatchLoad(load.id)).rejects.toMatchObject({ code: "load_not_assignable" });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: load.id } })).status).toBe("draft");
  });

  test("assigning from the queue answers in place: it assigns, says what is wrong, and wants a reason to double-book", async () => {
    const day = "2027-06-14";
    const first = await mkLoad("Q1", day);
    const second = await mkLoad("Q2", day);
    expect(await assignFromQueue({ loadId: first.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" })).toEqual({ ok: true });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: first.id } })).driverId).toBe(ids.Cheap);

    const clash = await assignFromQueue({ loadId: second.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40" });
    expect(clash).toMatchObject({ ok: false, code: "reasons_needed", error: expect.stringContaining("already on WC2-Q1") });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Cheap!, payKind: "cpm", rate: "0.40", overrideReason: "Two short hops, same dock" })).toEqual({ ok: true });

    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Lapsed!, payKind: "cpm", rate: "0.40" })).toMatchObject({ ok: false, error: expect.stringContaining("CDL") });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "cpm", rate: "abc" })).toEqual({ ok: false, error: "Type the pay rate, above zero." });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "percent", rate: "100" })).toMatchObject({ ok: false });
    expect(await assignFromQueue({ loadId: second.id, driverId: ids.Dear!, payKind: "percent", rate: "25" })).toEqual({ ok: true });
    expect((await prisma.assignment.findUniqueOrThrow({ where: { loadId: second.id } })).payKind).toBe("percent");
  });
});
