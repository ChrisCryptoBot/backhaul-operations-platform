/**
 * Seeds a SEPARATE database with a large invented fleet, to measure and prove the desk at scale: by default 1,500 tractors, 1,500 drivers,
 * 50,000 loads (each with two stops, most with a driver) and about 600 open loads. Nothing here is real. It uses the same workspace id the
 * app hard-codes, so point the app at this database to walk it.
 *
 *   docker exec backhaul-demo-pg psql -U demo -d postgres -c "create database demo_scale"
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale npx prisma migrate deploy --schema ../../prisma/schema.prisma
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale npx tsx scripts/seed-scale.ts
 *
 * Refuses to run against any database whose name is not demo_scale (so it can never wipe the demo data).
 * TRUCKS, DRIVERS and LOADS override the sizes.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL ?? "";
if (!/\/demo_scale(\?|$)/.test(url)) {
  console.error("Refusing to run: DATABASE_URL must point at the demo_scale database.");
  process.exit(1);
}

const prisma = new PrismaClient();
const WORKSPACE_ID = "demo-workspace";
const DAY = 86_400_000;
const TRUCKS = Number(process.env.TRUCKS ?? 1500);
const DRIVERS = Number(process.env.DRIVERS ?? 1500);
const LOADS = Number(process.env.LOADS ?? 50000);

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
const rand = rng(77);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const CITIES = [
  "Dallas, TX", "Houston, TX", "Atlanta, GA", "Chicago, IL", "Memphis, TN", "Nashville, TN", "Columbus, OH", "Harrisburg, PA", "Charlotte, NC",
  "Indianapolis, IN", "Kansas City, MO", "St. Louis, MO", "Oklahoma City, OK", "Louisville, KY", "Savannah, GA", "Denver, CO", "Phoenix, AZ", "Salt Lake City, UT"
] as const;
const CUSTOMERS = Array.from({ length: 60 }, (_, i) => `Customer ${String(i + 1).padStart(2, "0")}`);
const TRAILERS = ["dry_van", "reefer", "flatbed", "step_deck"] as const;
const FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Morgan", "Riley", "Jamie", "Drew", "Quinn", "Avery", "Reese"];
const LAST = ["Lee", "Ortiz", "Nguyen", "Brooks", "Patel", "Kim", "Reyes", "Carter", "Hughes", "Diaz", "Ward", "Price"];

async function chunked<T>(rows: T[], size: number, write: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

async function main() {
  const t0 = Date.now();
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE_ID } });
  await prisma.workspace.create({ data: { id: WORKSPACE_ID, name: "Scale fleet" } });
  const now = Date.now();

  const vehicleIds: string[] = [];
  const vehicles = Array.from({ length: TRUCKS }, (_, i) => {
    const id = randomUUID();
    vehicleIds.push(id);
    const base = pick(CITIES);
    return {
      id,
      workspaceId: WORKSPACE_ID,
      name: `Unit ${1000 + i}`,
      type: "heavy_duty",
      mpg: 6.4,
      fuelType: "diesel",
      homeBaseAddress: base,
      // A terminal per home city, so the header scope has a slice of about a fifty-fifth of the fleet each.
      terminal: base.split(",")[0]!,
      payloadLbs: 44000,
      maxLengthFt: 53,
      maxWidthFt: 8.5,
      maxHeightIn: 162,
      hasLiftgate: false,
      hasRamp: false,
      hasPalletJack: false
    };
  });
  await chunked(vehicles, 1000, (part) => prisma.vehicle.createMany({ data: part }));
  await chunked(
    vehicleIds.map((vehicleId) => ({
      vehicleId,
      monthlyInsurance: 1400,
      monthlyAuthority: 60,
      monthlyPhoneSubscriptions: 80,
      monthlyLoanPayment: 2100,
      estimatedMonthlyMiles: 9000,
      maintenanceReservePerMile: 0.15,
      tireReservePerMile: 0.05,
      driverHourlyTarget: 25,
      lastFuelPricePerGallon: 4.1,
      detentionHourlyRate: 50,
      breakEvenRpm: 1.62,
      survivalFloorRpm: 1.4,
      archetype: "solo_owner"
    })),
    1000,
    (part) => prisma.costProfile.createMany({ data: part })
  );

  const driverIds: string[] = [];
  const drivers = Array.from({ length: DRIVERS }, (_, i) => {
    const id = randomUUID();
    driverIds.push(id);
    return {
      id,
      workspaceId: WORKSPACE_ID,
      name: `${pick(FIRST)} ${pick(LAST)} ${i + 1}`,
      phone: `555-01${String(i % 100).padStart(2, "0")}`,
      cdlClass: "A",
      cdlExpiry: new Date(now + between(30, 900) * DAY),
      medicalCardExpiry: new Date(now + between(20, 700) * DAY),
      assignedVehicleId: i < vehicleIds.length ? vehicleIds[i]! : null,
      terminal: i < vehicles.length ? vehicles[i]!.terminal : pick(CITIES).split(",")[0]!,
      defaultPayKind: "cpm",
      defaultPayRate: 0.52
    };
  });
  await chunked(drivers, 1000, (part) => prisma.driver.createMany({ data: part }));

  // Loads: most completed over the last 18 months, some cancelled, ~600 open (draft, accepted, in progress) around now, ~400 saved quotes.
  const OPEN = Math.min(600, Math.floor(LOADS * 0.012));
  const QUOTES = Math.min(400, Math.floor(LOADS * 0.008));
  const loads: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  const assignments: Array<Record<string, unknown>> = [];
  const busy = new Set<string>();
  for (let i = 0; i < LOADS; i++) {
    const id = randomUUID();
    const kind = i < OPEN ? "open" : i < OPEN + QUOTES ? "quote" : rand() < 0.02 ? "cancelled" : "completed";
    const from = pick(CITIES);
    let to = pick(CITIES);
    if (to === from) to = CITIES[(CITIES.indexOf(from) + 1) % CITIES.length]!;
    const miles = round(between(120, 1100), 1);
    const offer = round(miles * between(1.9, 2.9), 2);
    const vehicleIdx = Math.floor(rand() * vehicleIds.length);
    const driverIdx = vehicleIdx % driverIds.length;
    const when =
      kind === "open" ? now + between(-1, 6) * DAY : kind === "quote" ? now + between(1, 10) * DAY : now - between(2, 540) * DAY;
    const status = kind === "open" ? pick(["draft", "accepted", "accepted", "in_progress"] as const) : kind === "quote" ? "quote" : kind;
    const invoiced = kind === "completed" && rand() < 0.97;
    const paid = invoiced && rand() < 0.8;
    const seq = i + 1;
    loads.push({
      id,
      workspaceId: WORKSPACE_ID,
      vehicleId: kind === "quote" ? null : vehicleIds[vehicleIdx],
      channel: "manual",
      brokerName: pick(CUSTOMERS),
      originAddress: from,
      destinationAddress: to,
      trailerType: pick(TRAILERS),
      loadedMiles: miles,
      quotedRevenue: offer,
      actualRevenue: kind === "completed" ? offer : null,
      status,
      scheduledDate: new Date(when),
      completedAt: kind === "completed" ? new Date(when + DAY) : null,
      cancelledAt: kind === "cancelled" ? new Date(when) : null,
      cancelReason: kind === "cancelled" ? "Customer cancelled" : null,
      payTermsDays: 30,
      stopsCount: 2,
      loadNumber: `SC-${seq}`,
      invoiceNumber: invoiced ? `INV-${seq}` : null,
      invoicedAmount: invoiced ? offer : null,
      paymentStatus: paid ? "paid" : invoiced ? "invoiced" : null,
      invoicedAt: invoiced ? new Date(when + 2 * DAY) : null,
      paidAt: paid ? new Date(when + between(10, 40) * DAY) : null,
      paidAmount: paid ? offer : null,
      snapshotBaseFloorRpm: kind === "completed" ? 1.62 : null,
      snapshotMpg: kind === "completed" ? 6.4 : null
    });
    const dayStart = new Date(Math.floor(when / DAY) * DAY + 8 * 3_600_000);
    stops.push(
      { id: randomUUID(), loadId: id, stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: from, timeWindowEarliest: dayStart, timeWindowLatest: new Date(dayStart.getTime() + 2 * 3_600_000) },
      { id: randomUUID(), loadId: id, stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: to, timeWindowEarliest: new Date(dayStart.getTime() + DAY), timeWindowLatest: new Date(dayStart.getTime() + DAY + 2 * 3_600_000), waitMinutes: kind === "completed" && rand() < 0.25 ? Math.round(between(30, 300)) : null }
    );
    if (kind !== "quote" && (kind !== "open" || status !== "draft")) {
      // One load per driver per day, as the double-booking guard requires, so open loads take distinct drivers.
      const key = `${driverIdx}-${Math.floor(when / DAY)}`;
      if (!busy.has(key)) {
        busy.add(key);
        assignments.push({
          id: randomUUID(),
          loadId: id,
          driverId: driverIds[driverIdx],
          payKind: "cpm",
          payRate: 0.52,
          payEstimate: round(miles * 0.52, 2),
          status: kind === "completed" ? "completed" : kind === "cancelled" ? "declined" : status === "in_progress" ? "in_progress" : "accepted"
        });
      }
    }
  }
  await chunked(loads, 4000, (part) => prisma.load.createMany({ data: part as never }));
  await chunked(stops, 8000, (part) => prisma.stop.createMany({ data: part as never }));
  await chunked(assignments, 4000, (part) => prisma.assignment.createMany({ data: part as never }));

  const counts = {
    vehicles: await prisma.vehicle.count(),
    drivers: await prisma.driver.count(),
    loads: await prisma.load.count(),
    stops: await prisma.stop.count(),
    assignments: await prisma.assignment.count()
  };
  console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`, counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
