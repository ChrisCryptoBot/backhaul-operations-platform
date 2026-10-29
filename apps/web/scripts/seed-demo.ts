/**
 * Seeds the TrueLane-shaped tables with an invented fleet: 3 trucks, 4 drivers, about 45 loads over 12 weeks with
 * stops, expenses, invoices and payments. Nothing here is real: the names, the brokers, the load and reference
 * numbers and the street-less city pairs are made up. Re-running replaces the demo workspace's data.
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo npx tsx scripts/seed-demo.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { computeBreakEvenRpm, computeSurvivalFloorRpm } from "../src/truelane/lib/domain/calculators";

const prisma = new PrismaClient();
const WORKSPACE_ID = "demo-workspace";
const DAY = 86_400_000;

// Deterministic pseudo-random so every run produces the same fleet.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(2026);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const BROKERS = ["Sample Freight Co", "Northline Brokerage", "Blue Mesa Logistics", "Harbor and Pine Freight", "Redwood Load Partners"];
const LANES: Array<{ from: string; to: string; miles: number; rpm: number }> = [
  { from: "Harrisburg, PA", to: "Columbus, OH", miles: 257.2, rpm: 2.35 },
  { from: "Dallas, TX", to: "Atlanta, GA", miles: 781, rpm: 2.05 },
  { from: "Houston, TX", to: "Memphis, TN", miles: 560, rpm: 2.15 },
  { from: "Chicago, IL", to: "Indianapolis, IN", miles: 183, rpm: 2.6 },
  { from: "Atlanta, GA", to: "Charlotte, NC", miles: 245, rpm: 2.3 },
  { from: "Nashville, TN", to: "Louisville, KY", miles: 175, rpm: 2.5 },
  { from: "Dallas, TX", to: "Oklahoma City, OK", miles: 206, rpm: 2.45 },
  { from: "Memphis, TN", to: "Dallas, TX", miles: 452, rpm: 2.0 },
  { from: "Columbus, OH", to: "Pittsburgh, PA", miles: 185, rpm: 2.55 },
  { from: "Kansas City, MO", to: "St. Louis, MO", miles: 248, rpm: 2.4 }
];
const DRIVERS = ["Alex Rivera", "Sam Okafor", "Jordan Lee", "Casey Brooks"];

const profileBase = {
  monthlyAuthority: 120,
  monthlyPhoneSubscriptions: 90,
  maintenanceReservePerMile: 0.15,
  tireReservePerMile: 0.04,
  driverHourlyTarget: 30,
  lastFuelPricePerGallon: 3.9
};

async function main() {
  // Clean slate for the demo workspace (children cascade).
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Demo fleet" } });

  const trucks = [
    { name: "Unit 101", type: "tractor", mpg: 6.8, insurance: 1450, loan: 1900, miles: 6500 },
    { name: "Unit 102", type: "tractor", mpg: 6.5, insurance: 1380, loan: 0, miles: 7000 },
    { name: "Unit 103", type: "box_truck", mpg: 9.2, insurance: 1100, loan: 1250, miles: 6000 }
  ];
  const vehicles: Array<{ id: string; mpg: number; breakEven: number }> = [];
  for (const t of trucks) {
    const input = {
      ...profileBase,
      monthlyInsurance: t.insurance,
      monthlyLoanPayment: t.loan,
      estimatedMonthlyMiles: t.miles,
      truckReplacementMonthly: t.loan === 0 ? 700 : 0,
      annualFixedCosts: 2400,
      archetype: "solo_owner"
    };
    const breakEven = computeBreakEvenRpm(input);
    const v = await prisma.vehicle.create({
      data: {
        workspaceId: WORKSPACE_ID,
        name: t.name,
        type: t.type,
        mpg: t.mpg,
        fuelType: "diesel",
        homeBaseAddress: "Dallas, TX",
        costProfile: {
          create: {
            monthlyInsurance: input.monthlyInsurance,
            monthlyAuthority: input.monthlyAuthority,
            monthlyPhoneSubscriptions: input.monthlyPhoneSubscriptions,
            monthlyLoanPayment: input.monthlyLoanPayment,
            estimatedMonthlyMiles: input.estimatedMonthlyMiles,
            maintenanceReservePerMile: input.maintenanceReservePerMile,
            tireReservePerMile: input.tireReservePerMile,
            driverHourlyTarget: input.driverHourlyTarget,
            lastFuelPricePerGallon: input.lastFuelPricePerGallon,
            truckReplacementMonthly: input.truckReplacementMonthly,
            annualFixedCosts: input.annualFixedCosts,
            archetype: "solo_owner",
            breakEvenRpm: round(breakEven, 4),
            survivalFloorRpm: round(computeSurvivalFloorRpm(input), 4)
          }
        }
      }
    });
    vehicles.push({ id: v.id, mpg: t.mpg, breakEven });
  }

  const drivers = [];
  for (const [i, name] of DRIVERS.entries()) {
    drivers.push(
      await prisma.driver.create({
        data: {
          workspaceId: WORKSPACE_ID,
          name,
          phone: `555-01${String(10 + i)}`,
          email: `driver${i + 1}@example.test`,
          cdlClass: "A",
          cdlExpiry: new Date(Date.now() + (200 + i * 90) * DAY),
          // The last driver's medical card lapses in 20 days, so the "lapses soon" alert has something to show.
          medicalCardExpiry: new Date(Date.now() + (i === DRIVERS.length - 1 ? 20 : 150 + i * 60) * DAY),
          assignedVehicleId: vehicles[i % vehicles.length].id
        }
      })
    );
  }

  const now = Date.now();
  let seq = 40000;

  // The deadhead-trap load from the site clips: $650 over 51 / 257.2 / 237 miles. Unassigned, waiting on the board.
  const demoLoad = {
    status: "draft",
    lane: LANES[0],
    offer: 650,
    pickupDh: 51,
    returnDh: 237,
    daysAgo: -2,
    brokerIdx: 0
  };

  type Plan = {
    status: "draft" | "accepted" | "in_progress" | "completed";
    lane: (typeof LANES)[number];
    offer: number;
    pickupDh: number;
    returnDh: number;
    daysAgo: number;
    brokerIdx: number;
    paid?: boolean;
    invoiced?: boolean;
    /** For a load that was sent and is waiting: how long ago, so the "no answer yet" alert has a real wait to measure. */
    sentHoursAgo?: number;
  };
  const plans: Plan[] = [demoLoad as Plan];
  // 4 more unassigned drafts. The first picks up in about 20 hours, so the "pickup is close and no driver" alert has one to show.
  for (let i = 0; i < 4; i++) {
    const lane = pick(LANES);
    plans.push({ status: "draft", lane, offer: round(lane.miles * lane.rpm * between(0.85, 1.1), 0), pickupDh: round(between(20, 90), 0), returnDh: round(between(60, 260), 0), daysAgo: i === 0 ? -0.5 : -1 - i, brokerIdx: i % BROKERS.length });
  }
  // 3 sent and waiting, 4 on the road. Drivers go round the four in order, and the windows are spread so that no driver is on
  // two loads at once, except one on purpose: the third sent load overlaps the load that driver is already running, which
  // is what the "double-booked" alert and the assignment guard are shown against.
  const SENT_DAYS = [-4, -5, -0.5];
  const SENT_HOURS_AGO = [2, 5, 9];
  for (let i = 0; i < 7; i++) {
    const lane = pick(LANES);
    plans.push({
      status: i < 3 ? "accepted" : "in_progress",
      lane,
      offer: round(lane.miles * lane.rpm * between(0.9, 1.15), 0),
      pickupDh: round(between(15, 80), 0),
      returnDh: round(between(40, 220), 0),
      daysAgo: i < 3 ? SENT_DAYS[i] : 0,
      brokerIdx: i % BROKERS.length,
      sentHoursAgo: i < 3 ? SENT_HOURS_AGO[i] : undefined
    });
  }
  // 30 finished over 12 weeks; the newest are invoiced and unpaid, the rest paid.
  for (let i = 0; i < 30; i++) {
    const lane = pick(LANES);
    const daysAgo = 3 + Math.floor((i / 30) * 84);
    plans.push({
      status: "completed",
      lane,
      offer: round(lane.miles * lane.rpm * between(0.88, 1.18), 0),
      pickupDh: round(between(10, 90), 0),
      returnDh: round(between(0, 240), 0),
      daysAgo,
      brokerIdx: i % BROKERS.length,
      invoiced: true,
      paid: daysAgo > 35 || i % 4 === 0
    });
  }

  let drvCursor = 0;
  const audits: Prisma.AuditEventCreateManyInput[] = [];
  for (const p of plans) {
    seq += 1;
    // The deadhead-trap load always runs on Unit 101 so its floor is the one the site clips describe.
    const vehicle = p === (demoLoad as Plan) ? vehicles[0] : vehicles[seq % vehicles.length];
    const when = new Date(now - p.daysAgo * DAY);
    const loaded = p.lane.miles;
    const covered = p.status === "completed" && rand() < 0.35; // some finished loads had a load back
    const returnDh = covered ? 0 : p.returnDh;
    const fuelGallons = (p.pickupDh + loaded + returnDh) / vehicle.mpg;
    const fuel = p.status === "completed" ? round(fuelGallons * between(3.6, 4.2)) : 0;
    const tolls = p.status === "completed" ? round(between(0, 60)) : 0;
    const bench = round((p.offer / (p.pickupDh + loaded + p.returnDh)) * between(0.9, 1.25), 2);
    const invoicedAt = p.invoiced ? new Date(when.getTime() + 1 * DAY) : null;
    // A payment cannot be dated after today: a recent invoice that would only be paid weeks from now stays invoiced and unpaid.
    const dueToPay = p.paid && invoicedAt ? new Date(invoicedAt.getTime() + Math.floor(between(18, 34)) * DAY) : null;
    const paidAt = dueToPay && dueToPay.getTime() <= now ? dueToPay : null;
    const load = await prisma.load.create({
      data: {
        workspaceId: WORKSPACE_ID,
        vehicleId: vehicle.id,
        channel: "dispatch",
        brokerName: BROKERS[p.brokerIdx],
        originAddress: p.lane.from,
        destinationAddress: p.lane.to,
        trailerType: vehicle.mpg > 9 ? "box_truck" : "dry_van",
        pickupDeadheadMiles: p.pickupDh,
        loadedMiles: loaded,
        returnDeadheadMiles: returnDh,
        quotedRevenue: p.offer,
        actualRevenue: p.status === "completed" ? p.offer : null,
        fuelSurcharge: 0,
        expenseFuelActual: fuel,
        expenseTolls: tolls,
        status: p.status,
        scheduledDate: when,
        completedAt: p.status === "completed" ? new Date(when.getTime() + 1 * DAY) : null,
        isBackhaul: covered,
        stopsCount: 2,
        payTermsDays: 30,
        paymentTerms: "net_30",
        marketBenchmark: bench,
        loadNumber: `DM-${seq}`,
        poNumber: `PO-${Math.floor(between(10000, 99999))}`,
        pickupNumbers: [`PU-${Math.floor(between(1000, 9999))}`],
        deliveryNumbers: [`DEL-${Math.floor(between(1000, 9999))}`],
        invoiceNumber: invoicedAt ? `INV-${seq}` : null,
        invoicedAmount: invoicedAt ? p.offer : null,
        paymentStatus: paidAt ? "paid" : invoicedAt ? "invoiced" : null,
        invoicedAt,
        paidAt,
        paidAmount: paidAt ? p.offer : null,
        snapshotBaseFloorRpm: p.status === "draft" ? null : round(vehicle.breakEven, 4),
        snapshotArchetype: p.status === "draft" ? null : "solo_owner",
        snapshotMpg: p.status === "draft" ? null : vehicle.mpg,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: p.lane.from, facilityName: `${p.lane.from.split(",")[0]} Distribution`, timeWindowEarliest: new Date(when.getTime() + 8 * 3600_000), timeWindowLatest: new Date(when.getTime() + 11 * 3600_000), referenceNumbers: [`PU-${seq}`], waitMinutes: p.status === "completed" ? Math.floor(between(0, 150)) : null },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: p.lane.to, facilityName: `${p.lane.to.split(",")[0]} Receiving`, timeWindowEarliest: new Date(when.getTime() + 1 * DAY + 8 * 3600_000), timeWindowLatest: new Date(when.getTime() + 1 * DAY + 12 * 3600_000), referenceNumbers: [`DEL-${seq}`], stopNotes: "Check in at the gate", waitMinutes: p.status === "completed" ? Math.floor(between(0, 120)) : null }
          ]
        },
        segments:
          p.status === "completed"
            ? {
                create: [
                  { segmentType: "pickup_dh", miles: p.pickupDh },
                  { segmentType: "loaded", miles: loaded },
                  ...(returnDh > 0 ? [{ segmentType: "return_dh", miles: returnDh }] : [])
                ]
              }
            : undefined
      }
    });
    if (p.status !== "draft") {
      const driver = drivers[drvCursor++ % drivers.length];
      const kind = drvCursor % 3 === 0 ? "flat" : "cpm";
      const rate = kind === "flat" ? round(p.offer * 0.7, 0) : 0.68;
      const est = kind === "flat" ? rate : round(rate * loaded, 2);
      const dispatchedAt = p.sentHoursAgo != null ? new Date(now - p.sentHoursAgo * 3_600_000) : new Date(when.getTime() - DAY);
      const respondedAt = p.status === "accepted" ? null : new Date(when.getTime() - DAY / 2);
      await prisma.assignment.create({
        data: {
          loadId: load.id,
          driverId: driver.id,
          payKind: kind,
          payRate: new Prisma.Decimal(rate),
          payEstimate: est,
          status: p.status === "accepted" ? "dispatched" : p.status === "in_progress" ? "in_progress" : "completed",
          dispatchedAt,
          respondedAt
        }
      });

      // The history that would exist by now: assigned, sent, answered, and for finished loads invoiced and paid.
      const payText = kind === "flat" ? `Flat $${rate.toFixed(2)}` : `$${rate.toFixed(2)}/mi`;
      const base = { workspaceId: WORKSPACE_ID, loadId: load.id, loadNumber: load.loadNumber, actor: "Dispatcher" };
      audits.push({ ...base, entity: "assignment", action: "assigned", summary: `${driver.name} assigned at ${payText}`, before: Prisma.JsonNull, after: { Driver: driver.name, Pay: payText, Estimate: `$${est.toFixed(2)}` }, createdAt: new Date(dispatchedAt.getTime() - 3_600_000) });
      audits.push({ ...base, entity: "assignment", action: "sent", summary: `Sent to ${driver.name}`, before: { Status: "Assigned, not sent" }, after: { Status: "Sent, waiting" }, createdAt: dispatchedAt });
      if (respondedAt) audits.push({ ...base, entity: "assignment", action: "accepted", summary: `${driver.name} accepted`, before: { Status: "Sent, waiting" }, after: { Status: "Driver accepted" }, createdAt: respondedAt });
      if (invoicedAt) audits.push({ ...base, entity: "invoice", action: "invoiced", summary: `INV-${seq} created for $${p.offer.toFixed(2)}`, before: { Invoice: null, Amount: null }, after: { Invoice: `INV-${seq}`, Amount: `$${p.offer.toFixed(2)}`, Terms: "Net 30" }, createdAt: invoicedAt });
      if (paidAt) audits.push({ ...base, entity: "invoice", action: "paid", summary: `INV-${seq} paid, $${p.offer.toFixed(2)}`, before: { Status: "Invoiced" }, after: { Status: "Paid", Amount: `$${p.offer.toFixed(2)}` }, createdAt: paidAt });
    }
  }
  await prisma.auditEvent.createMany({ data: audits });

  const counts = {
    vehicles: await prisma.vehicle.count(),
    drivers: await prisma.driver.count(),
    loads: await prisma.load.count(),
    stops: await prisma.stop.count(),
    assignments: await prisma.assignment.count(),
    auditEvents: await prisma.auditEvent.count()
  };
  console.log("seeded", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
