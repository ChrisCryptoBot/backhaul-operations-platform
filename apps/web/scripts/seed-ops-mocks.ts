import { PrismaClient, DisruptionKind, DisruptionReason } from "@prisma/client";
import { recomputeWeekSnapshot } from "@/server/snapshots";

const prisma = new PrismaClient();

async function main() {
  const region = await prisma.region.findFirst();
  if (!region) {
    throw new Error("No region found. Cannot seed.");
  }

  const dropLots = await prisma.dropLot.findMany({ where: { regionId: region.id }, take: 3 });
  if (dropLots.length === 0) {
    throw new Error("No drop lots found.");
  }

  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        id: "mock-user-1",
        email: "mock@example.com",
        name: "Mock User",
      }
    });
  }

  const weekIso = "2026-W27";
  const pickupDay = "2026-07-03";
  const deliveryDay = "2026-07-04";

  // Clean up previous W27 mocks
  await prisma.load.deleteMany({
    where: { regionId: region.id, weekIso }
  });

  console.log(`Seeding 15 mock loads for region ${region.code} and week ${weekIso}...`);

  const lane = await prisma.lane.findFirst({ where: { regionId: region.id } });
  
  const drivers = ["S. Romano", "T. Nguyen", "J. Morales", "A. Smith", "C. Davis"];
  const driverTypes = ["SHUTTLE", "PTP", "SHUTTLE", "PTP", "LTL"];
  const reasons: DisruptionReason[] = [
    "CARRIER_NO_SHOW", "WEATHER_ROAD", "NO_DOCK_TIME",
    "EQUIPMENT_ISSUE", "RATE_BILLING_DISPUTE", "CARRIER_LATE_OR_NOT_EMPTY"
  ];

  // A realistic labeled reference-number set per load (as if pulled from the rate con):
  // always a PU + PO + BOL, with a second PU / seal / pro sprinkled in for variety.
  // referenceNumbers is the master; pickupNumber(s) derive from the PU-kind entries.
  function buildNumbers(i: number) {
    const pu1 = `PU-3P-${104900 + i}`;
    const refs: Array<{ kind: string; value: string; source: "RATE_CON" }> = [
      { kind: "PU", value: pu1, source: "RATE_CON" },
    ];
    if (i % 4 === 0) refs.push({ kind: "PU", value: `${pu1}-B`, source: "RATE_CON" });
    refs.push({ kind: "PO", value: `PO-${88000 + i * 3}`, source: "RATE_CON" });
    refs.push({ kind: "BOL", value: `BOL-${45000 + i * 11}`, source: "RATE_CON" });
    if (i % 3 === 0) refs.push({ kind: "SEAL", value: `SL-${String(9000 + i).padStart(5, "0")}`, source: "RATE_CON" });
    if (i % 5 === 0) refs.push({ kind: "PRO", value: `PRO-${600000 + i * 7}`, source: "RATE_CON" });
    const pickupNumbers = refs.filter((r) => r.kind === "PU").map((r) => r.value);
    return {
      loadNumber: `MG${459800 + i}`,
      pickupNumber: pickupNumbers[0] ?? null,
      pickupNumbers,
      referenceNumbers: refs,
    };
  }

  for (let i = 0; i < 15; i++) {
    const dropLot = dropLots[i % dropLots.length];
    const driverType = driverTypes[i % driverTypes.length] as any;
    const driverName = drivers[i % drivers.length];
    const nextDriverName = drivers[(i + 1) % drivers.length];
    const status = i === 13 ? "CANCELED" : i === 14 ? "FAILED" : "COMPLETED";

    // Alternate outcomes:
    // Evens are on-time, odds are slightly late or missed
    // Shuttle gets controllable deadhead, PTP gets expected deadhead
    const isOnTime = i % 2 === 0;
    const isShuttle = driverType === "SHUTTLE";
    const puDeadhead = isShuttle ? (20 + (i * 10)) : 0;
    const delDeadhead = isShuttle ? 0 : (10 + (i * 5));
    const nums = buildNumbers(i);

    const load = await prisma.load.create({
      data: {
        regionId: region.id,
        dropLotId: dropLot.id,
        weekIso,
        loadNumber: nums.loadNumber,
        pickupNumber: nums.pickupNumber,
        pickupNumbers: nums.pickupNumbers,
        referenceNumbers: nums.referenceNumbers,
        bookingDate: new Date(`${pickupDay}T${String(8 + (i % 4)).padStart(2, '0')}:00:00Z`), // Spread between 8am and 11am
        pickupDate: new Date(`${pickupDay}T1${(i % 5)}:00:00Z`), // 10am to 2pm
        status,
        createdById: user.id,
        pickupCity: lane?.originCity,
        pickupState: lane?.originState,
        deliveryCity: lane?.destinationCity,
        deliveryState: lane?.destinationState,
        lineHaulRate: 1000 + (i * 50),
        loadedMiles: 200 + (i * 20),
        puDeadheadMiles: puDeadhead,
        delDeadheadMiles: delDeadhead,
        fscApplies: false,
        pickupWindowEnd: new Date(`${pickupDay}T14:00:00Z`),
        deliveryWindowEnd: new Date(`${deliveryDay}T14:00:00Z`),
        deliveryApptType: i % 3 === 0 ? "FIRM_APPT" : "OPEN_WINDOW",
        driverType,
        legs: status === "CANCELED" ? undefined : {
          create: [
            {
              legIndex: 0,
              legType: driverType === "LTL" ? "PTP" : driverType,
              driverName: driverName,
              arrivalAt: new Date(`${pickupDay}T1${isOnTime ? '2' : '5'}:30:00Z`), // On time if <= 14:00
            },
            {
              legIndex: 1,
              legType: "DELIVERY",
              driverName: nextDriverName,
              arrivalAt: new Date(`${deliveryDay}T1${isOnTime ? '1' : '6'}:00:00Z`), // On time if <= 14:00
            }
          ]
        }
      }
    });

    // Add some disruption events to the first 4 loads and the canceled one
    if (i < 4 || status === "CANCELED") {
      await prisma.loadDisruptionEvent.create({
        data: {
          loadId: load.id,
          regionId: region.id,
          weekIso,
          kind: status === "CANCELED" ? "CANCEL" : "RESCHEDULE",
          reason: reasons[i % reasons.length],
          actorId: user.id,
        }
      });
    }
  }

  // Recompute the weekly snapshot so the KPI dashboard headline cards (loads,
  // revenue, empty %, …) reflect these loads instead of falling back to a prior week.
  await recomputeWeekSnapshot(region.id, weekIso, user.id, prisma);

  console.log("15 mock loads created + W27 snapshot recomputed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
