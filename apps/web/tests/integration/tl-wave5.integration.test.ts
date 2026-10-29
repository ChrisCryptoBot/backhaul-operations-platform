import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver } from "@/server/tl/dispatch";
import { detentionOfLoad } from "@/server/tl/detention";
import { getTruckDetail, saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { getLoadDetail } from "@/server/tl/queries";
import { readRateCon } from "@/server/ratecon/reader";
import { saveReviewedDraft } from "@/server/ratecon/save";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own truck, driver and loads (all named W5) and removes them and
 * their audit events afterwards, so the demo data is left as the seed wrote it.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const D = 24 * 3_600_000;

const form: Record<string, string> = {
  monthlyInsurance: "800",
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "3.9",
  driverHourlyTarget: "25",
  detentionHourlyRate: "60",
  freeGraceMinutes: "120",
  archetype: "hired_driver",
  payKind: "cpm",
  hiredDriverRatePerMile: "0.55",
  laborBurdenPct: "18",
  factoringFeePct: "3",
  insuranceItemised: "1",
  insuranceLiabilityMonthly: "700",
  insuranceCargoMonthly: "100",
  routeMinimumOn: "1",
  routeBaseMinimum: "180",
  routeIncludedMiles: "60",
  routeIncludedStops: "6",
  routeOveragePerMile: "1.25",
  routeOveragePerStop: "10"
};

describe.skipIf(!run)("cost profile, driver pay and the frozen snapshot on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  let truckId = "";
  let driverId = "";

  const formOf = (d: NonNullable<Awaited<ReturnType<typeof getTruckDetail>>>) => ({
    ...Object.fromEntries(Object.entries(d.numbers).map(([k, v]) => [k, v == null ? "" : String(v)])),
    archetype: d.choices.archetype,
    payKind: d.choices.payKind,
    fscCut: d.choices.fscCut ?? "",
    insuranceItemised: d.choices.insuranceItemised ? "1" : "",
    routeMinimumOn: d.choices.routeMinimumOn ? "1" : ""
  });

  async function makeLoad(n: string, extraDays = 0) {
    const base = Date.now() + (40 + extraDays) * D;
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        vehicleId: truckId,
        loadNumber: `W5-${n}`,
        status: "draft",
        brokerName: "W5 Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        pickupDeadheadMiles: 40,
        returnDeadheadMiles: 240,
        quotedRevenue: 900,
        scheduledDate: new Date(base),
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(base), timeWindowLatest: new Date(base + 3 * 3_600_000), referenceNumbers: ["PU"] },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(base + 6 * 3_600_000), timeWindowLatest: new Date(base + 9 * 3_600_000), referenceNumbers: ["DEL"] }
          ]
        }
      }
    });
    loadIds.push(l.id);
    return l;
  }

  beforeAll(async () => {
    const t = await saveTruck({ name: "W5 Truck", type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    const d = await saveDriver({ name: "W5 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error(`driver ${JSON.stringify(d)}`);
    driverId = d.id;
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: loadIds } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W5" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W5" } } });
  });

  test("a driver keeps a usual pay, and the audit trail says what it was", async () => {
    const d = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    expect(d.defaultPayKind).toBe("cpm");
    expect(num(d.defaultPayRate)).toBe(0.6);
    const out = await saveDriver({ name: "W5 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", payKind: "hourly", payRate: "22" }, driverId);
    expect(out).toMatchObject({ ok: true, changed: true });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entity: "fleet", action: "driver_changed", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect((ev.before as Record<string, unknown>)["Usual pay"]).toBe("$0.6 a mile");
    expect((ev.after as Record<string, unknown>)["Usual pay"]).toBe("$22 an hour");
    await saveDriver({ name: "W5 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", payKind: "cpm", payRate: "0.60" }, driverId);
  });

  test("an Owner + driver profile with itemised insurance and a route minimum is stored as the phone stores it, and reads back the same", async () => {
    const out = await saveCostProfile(truckId, form);
    expect(out).toMatchObject({ ok: true, changed: true });
    const p = await prisma.costProfile.findUniqueOrThrow({ where: { vehicleId: truckId } });
    expect(p.archetype).toBe("hired_driver");
    expect(p.hiredDriverPayKind).toBe("cpm");
    expect(num(p.hiredDriverRatePerMile)).toBe(0.55);
    expect(num(p.laborBurdenPct)).toBe(0.18); // typed as 18, kept as a fraction
    expect(num(p.factoringFeePct)).toBe(0.03);
    expect(num(p.monthlyInsurance)).toBe(800); // the sum of the buckets
    expect(num(p.insuranceLiabilityMonthly)).toBe(700);
    expect(num(p.insuranceCargoMonthly)).toBe(100);
    expect(num(p.dailyRevenueTarget)).toBe(350); // blank means the phone's 350
    expect(num(p.routeBaseMinimum)).toBe(180);
    expect(p.routeIncludedStops).toBe(6);
    expect(p.hourlyTargetConfirmedAt).not.toBeNull();
    expect(p.carrierCutPct).toBeNull();

    const detail = (await getTruckDetail(truckId))!;
    expect(detail.choices).toEqual({ archetype: "hired_driver", payKind: "cpm", fscCut: null, insuranceItemised: true, routeMinimumOn: true });
    expect(detail.numbers.laborBurdenPct).toBe(18);
    // Posting back what the form shows changes nothing.
    expect(await saveCostProfile(truckId, formOf(detail))).toMatchObject({ ok: true, changed: false });
  });

  test("switching to leased-on keeps the driver's pay where it was, and the audit entry names what moved", async () => {
    const detail = (await getTruckDetail(truckId))!;
    const out = await saveCostProfile(truckId, { ...formOf(detail), archetype: "leased_on", carrierCutPct: "20", fscCut: "no", routeMinimumOn: "" });
    expect(out).toMatchObject({ ok: true, changed: true });
    const p = await prisma.costProfile.findUniqueOrThrow({ where: { vehicleId: truckId } });
    expect(p.archetype).toBe("leased_on");
    expect(num(p.carrierCutPct)).toBe(0.2);
    expect(p.fscCutApplies).toBe("no");
    expect(num(p.hiredDriverRatePerMile)).toBe(0.55); // kept
    expect(num(p.laborBurdenPct)).toBe(0.18); // kept
    expect(p.routeBaseMinimum).toBeNull(); // route minimum off clears it
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entity: "fleet", action: "cost_profile_changed", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(Object.keys(ev.after as object)).toEqual(expect.arrayContaining(["Who drives", "Carrier's cut (%)", "Route minimum"]));
    // And back, so the next tests have a driver-paid truck.
    const back = (await getTruckDetail(truckId))!;
    await saveCostProfile(truckId, { ...formOf(back), archetype: "hired_driver", routeMinimumOn: "1", routeBaseMinimum: "180" });
    expect((await getTruckDetail(truckId))!.choices.archetype).toBe("hired_driver");
  });

  test("assigning a driver freezes the pay into the load; a later profile edit does not rewrite the floor it was booked at", async () => {
    const load = await makeLoad("1");
    expect(load.snapshotBaseFloorRpm).toBeNull();
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "cpm", rate: 0.7 } });
    const frozen = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    const floor = num((await prisma.costProfile.findUniqueOrThrow({ where: { vehicleId: truckId } })).breakEvenRpm);
    expect(num(frozen.snapshotBaseFloorRpm)).toBeCloseTo(floor, 4);
    expect(frozen.snapshotArchetype).toBe("hired_driver");
    expect(num(frozen.snapshotMpg)).toBe(10);
    expect(num(frozen.snapshotLaborCpm)).toBeCloseTo(0.7 * 1.18, 3); // the assignment's pay and the truck's burden
    expect(num(frozen.snapshotDetentionRate)).toBe(60);
    expect(frozen.snapshotFreeGraceMinutes).toBe(120);

    // The truck's costs go up. The load keeps the floor it was booked at.
    const detail = (await getTruckDetail(truckId))!;
    await saveCostProfile(truckId, { ...formOf(detail), monthlyAuthority: "900", insuranceItemised: "1", detentionHourlyRate: "90" });
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "cpm", rate: 0.8 } });
    const later = await prisma.load.findUniqueOrThrow({ where: { id: load.id } });
    expect(num(later.snapshotBaseFloorRpm)).toBeCloseTo(floor, 4); // written once
    expect(num(later.snapshotDetentionRate)).toBe(60); // so are the dock terms
    expect(num(later.snapshotLaborCpm)).toBeCloseTo(0.8 * 1.18, 3); // the pay follows the assignment until the load is on the road
    // The dock terms the load was booked with are what detention reads, not the truck's new $90.
    const withStops = await prisma.load.findUniqueOrThrow({ where: { id: load.id }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
    expect(detentionOfLoad(withStops, 120).rate).toBe(60);
  });

  test("the load's page says whose pay is in the verdict", async () => {
    const load = await makeLoad("2", 3); // another day: one driver cannot be on two loads at once
    const alone = (await getLoadDetail(load.id))!;
    expect(alone.labourNote).toMatch(/truck's cost profile: \$0\.55 a mile, plus 18% payroll burden/);
    await assignDriver({ loadId: load.id, driverId, pay: { kind: "flat", rate: 400 } });
    const assigned = (await getLoadDetail(load.id))!;
    expect(assigned.labourNote).toMatch(/Driver pay from this assignment: \$400\.00 flat, which is \$0\.\d\d a mile over every mile of the trip, plus 18% payroll burden/);
    expect(assigned.evaluation!.tripLaborCpm).toBeGreaterThan(0);
    // Flat pay spread over all 540 miles (40 + 260 + 240), with the burden on top.
    expect(assigned.evaluation!.tripLaborCpm).toBeCloseTo((400 / 540) * 1.18, 3);
  });

  test("a rate confirmation saved with a truck is booked with that truck's floor frozen", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913.pdf" }, {});
    if (!out.ok) throw new Error("expected a reading");
    const saved = await saveReviewedDraft({ ...out.draft, confirmed: true, vehicleId: truckId });
    loadIds.push(saved.id);
    const row = await prisma.load.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.snapshotBaseFloorRpm).not.toBeNull();
    expect(row.snapshotArchetype).toBe("hired_driver");
    expect(row.snapshotLaborCpm).toBeNull(); // nobody drives it yet, so no pay to freeze
    const without = await saveReviewedDraft({ ...out.draft, confirmed: true });
    loadIds.push(without.id);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: without.id } })).snapshotBaseFloorRpm).toBeNull(); // no truck, nothing to freeze
  });
});
