import { PrismaClient, BrokerOnboardingStatus, LoadStatus, ParseState, ReviewDecision, Role, RuleSeverity } from "@prisma/client";

const prisma = new PrismaClient();

function weekIsoFromDate(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addWeeks(date, weeks) {
  return addDays(date, weeks * 7);
}

async function main() {
  const now = new Date();
  const bookingDate = new Date(now);
  bookingDate.setHours(12, 0, 0, 0);
  const pickupDate = new Date(bookingDate);
  const weekIso = weekIsoFromDate(bookingDate);

  await prisma.$transaction(async (tx) => {
    const region = await tx.region.upsert({
      where: { code: "NE" },
      update: { name: "Northeast" },
      create: { code: "NE", name: "Northeast" }
    });

    // Remove stale weekly aggregates so showcase weeks remain deterministic.
    await tx.weekSnapshot.deleteMany({
      where: { regionId: region.id }
    });

    const user = await tx.user.upsert({
      where: { id: "showcase-user" },
      update: {
        email: "showcase@local.dev",
        name: "Showcase User"
      },
      create: {
        id: "showcase-user",
        email: "showcase@local.dev",
        name: "Showcase User"
      }
    });

    await tx.userRegionRole.upsert({
      where: {
        userId_regionId: {
          userId: user.id,
          regionId: region.id
        }
      },
      update: { role: Role.ADMIN },
      create: {
        userId: user.id,
        regionId: region.id,
        role: Role.ADMIN
      }
    });

    await tx.dropLot.deleteMany({
      where: {
        regionId: region.id,
        id: { in: ["lot-showcase-lsps01", "lot-showcase-harr01", "lot-showcase-batavia", "lot-showcase-adhoc-ltl"] }
      }
    });

    const dropLots = [
      {
        id: "lot-showcase-cdc-bh",
        name: "LOCAL CDC BH",
        code: "CDC-BH",
        note: "Local backhaul bucket from board template.",
        city: "Carlisle",
        state: "PA",
        sortOrder: 1,
        dailyCapacity: 8,
        slipSeat: true,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-cdc-ib",
        name: "LOCAL CDC INBOUND",
        code: "CDC-IB",
        note: "Inbound regional bucket from board template.",
        city: "Carlisle",
        state: "PA",
        sortOrder: 2,
        dailyCapacity: 8,
        slipSeat: false,
        dropHookRequired: false
      },
      {
        id: "lot-showcase-cdc-hub",
        name: "CARLISLE, PA (CDC)",
        code: "CDC",
        city: "Carlisle",
        state: "PA",
        sortOrder: 3,
        dailyCapacity: 8,
        slipSeat: true,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-rly4",
        name: "LAKESIDE, ME (RLY4)",
        code: "RLY4",
        city: "Lakeside",
        state: "ME",
        sortOrder: 4,
        dailyCapacity: 2,
        slipSeat: false,
        dropHookRequired: false
      },
      {
        id: "lot-showcase-rly5",
        name: "EASTON, MA (RLY5)",
        code: "RLY5",
        city: "Easton",
        state: "MA",
        sortOrder: 5,
        dailyCapacity: 5,
        slipSeat: true,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-rly1",
        name: "BROOKHAVEN, NY (RLY1)",
        code: "RLY1",
        city: "Brookhaven",
        state: "NY",
        sortOrder: 6,
        dailyCapacity: 3,
        slipSeat: true,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-rly2",
        name: "FAIRVIEW, NY (RLY2)",
        code: "RLY2",
        city: "Fairview",
        state: "NY",
        sortOrder: 7,
        dailyCapacity: 2,
        slipSeat: false,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-rly3",
        name: "WESTBROOK, PA (RLY3)",
        code: "RLY3",
        city: "Westbrook",
        state: "PA",
        sortOrder: 8,
        dailyCapacity: 3,
        slipSeat: true,
        dropHookRequired: true
      },
      {
        id: "lot-showcase-ltl",
        name: "LTL",
        code: "LTL",
        note: "Retail trucks without a fixed drop lot; typically deadhead to CDC unless backhaul is sourced.",
        city: "Carlisle",
        state: "PA",
        sortOrder: 9,
        dailyCapacity: 2,
        slipSeat: false,
        dropHookRequired: false
      }
    ];

    for (const lot of dropLots) {
      await tx.dropLot.upsert({
        where: { id: lot.id },
        update: {
          regionId: region.id,
          name: lot.name,
          code: lot.code ?? null,
          note: lot.note ?? null,
          city: lot.city,
          state: lot.state,
          sortOrder: lot.sortOrder,
          dailyCapacity: lot.dailyCapacity,
          slipSeat: lot.slipSeat,
          dropHookRequired: lot.dropHookRequired
        },
        create: {
          ...lot,
          regionId: region.id
        }
      });
    }

    await tx.lane.deleteMany({
      where: {
        regionId: region.id,
        originCity: "Batavia",
        destinationCity: "Carlisle",
        destinationState: "PA"
      }
    });

    // Brokers with varied onboarding status + FSC posture, each with a few contacts
    // so the Brokers manager (master-detail, contacts table, FSC flag) fills out.
    const brokerSeeds = [
      {
        id: "broker-showcase-summit",
        name: "Summit Transport LLC",
        onboardingStatus: BrokerOnboardingStatus.APPROVED,
        fscDefaultApplies: true,
        reps: [
          { id: "rep-summit-1", name: "Dana Alvarez", email: "dana.alvarez@summittransport.com", phone: "(484) 555-0142" },
          { id: "rep-summit-2", name: "Marcus Webb", email: "marcus.webb@summittransport.com", phone: "(484) 555-0177" }
        ]
      },
      {
        id: "broker-showcase-northway",
        name: "Northway Logistics",
        onboardingStatus: BrokerOnboardingStatus.APPROVED,
        fscDefaultApplies: true,
        reps: [
          { id: "rep-northway-1", name: "Priya Nair", email: "pnair@northwaylogistics.com", phone: "(610) 555-0203" },
          { id: "rep-northway-2", name: "Tom Briggs", email: "tbriggs@northwaylogistics.com", phone: "(610) 555-0288" },
          { id: "rep-northway-3", name: "Elena Cho", email: "echo@northwaylogistics.com", phone: null }
        ]
      },
      {
        id: "broker-showcase-keystone",
        name: "Keystone Freight Brokers",
        onboardingStatus: BrokerOnboardingStatus.PENDING,
        fscDefaultApplies: false,
        reps: [
          { id: "rep-keystone-1", name: "Raj Patel", email: "raj@keystonefreight.com", phone: "(717) 555-0119" }
        ]
      },
      {
        id: "broker-showcase-atlas",
        name: "Atlas 3PL Partners",
        onboardingStatus: BrokerOnboardingStatus.BLOCKED,
        fscDefaultApplies: true,
        reps: [
          { id: "rep-atlas-1", name: "Gwen Foster", email: "gwen.foster@atlas3pl.com", phone: "(412) 555-0164" },
          { id: "rep-atlas-2", name: "Sam Ortiz", email: null, phone: "(412) 555-0198" }
        ]
      },
      {
        id: "broker-showcase-greenline",
        name: "Greenline Carriers",
        onboardingStatus: BrokerOnboardingStatus.APPROVED,
        fscDefaultApplies: false,
        reps: [
          { id: "rep-greenline-1", name: "Hannah Lee", email: "hlee@greenlinecarriers.com", phone: "(607) 555-0231" },
          { id: "rep-greenline-2", name: "Diego Ramos", email: "dramos@greenlinecarriers.com", phone: "(607) 555-0245" }
        ]
      }
    ];

    let broker = null;
    for (const b of brokerSeeds) {
      const createdBroker = await tx.broker.upsert({
        where: { id: b.id },
        update: {
          regionId: region.id,
          name: b.name,
          onboardingStatus: b.onboardingStatus,
          fscDefaultApplies: b.fscDefaultApplies
        },
        create: {
          id: b.id,
          regionId: region.id,
          name: b.name,
          onboardingStatus: b.onboardingStatus,
          fscDefaultApplies: b.fscDefaultApplies
        }
      });
      if (!broker) broker = createdBroker; // first broker (Summit) stays the default for loads
      for (const rep of b.reps) {
        await tx.brokerRep.upsert({
          where: { id: rep.id },
          update: { brokerId: createdBroker.id, name: rep.name, email: rep.email ?? null, phone: rep.phone ?? null, deletedAt: null },
          create: { id: rep.id, brokerId: createdBroker.id, name: rep.name, email: rep.email ?? null, phone: rep.phone ?? null }
        });
      }
    }

    const lanes = [
      {
        originCity: "Lakeside",
        originState: "ME",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "1700"
      },
      {
        originCity: "Easton",
        originState: "MA",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "700"
      },
      {
        originCity: "Brookhaven",
        originState: "NY",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "1150"
      },
      {
        originCity: "Fairview",
        originState: "NY",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "1300"
      },
      {
        originCity: "Westbrook",
        originState: "PA",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "1350"
      },
      {
        originCity: "LTL (ALL CITIES)",
        originState: "NA",
        destinationCity: "Carlisle",
        destinationState: "PA",
        targetRate: "1200"
      }
    ];

    for (const lane of lanes) {
      await tx.lane.upsert({
        where: {
          regionId_originCity_originState_destinationCity_destinationState: {
            regionId: region.id,
            originCity: lane.originCity,
            originState: lane.originState,
            destinationCity: lane.destinationCity,
            destinationState: lane.destinationState
          }
        },
        update: {
          targetRate: lane.targetRate
        },
        create: {
          regionId: region.id,
          originCity: lane.originCity,
          originState: lane.originState,
          destinationCity: lane.destinationCity,
          destinationState: lane.destinationState,
          targetRate: lane.targetRate
        }
      });
    }

    const rateConfirmation = await tx.rateConfirmation.upsert({
      where: { sourceFileHash: "showcase-rc-hash-001" },
      update: {
        parseState: ParseState.EXTRACTED,
        reviewDecision: ReviewDecision.APPROVED
      },
      create: {
        regionId: region.id,
        weekIso,
        sourceFileUrl: "https://example.com/showcase-rc-001.pdf",
        sourceFileHash: "showcase-rc-hash-001",
        parseState: ParseState.EXTRACTED,
        reviewDecision: ReviewDecision.APPROVED,
        parseConfidence: "0.94",
        extractedPayload: { shipperName: "Acme Foods LLC", receiverName: "BigBox DC Northeast" }
      }
    });

    const loads = [
      {
        id: "showcase-load-001",
        status: LoadStatus.PICKED_UP,
        dropLotId: "lot-showcase-cdc-bh",
        ref: "3P-104821",
        routeId: "RT-104821",
        shipperName: "Acme Foods LLC",
        pickupCity: "Pittsburgh",
        pickupState: "PA",
        receiverName: "BigBox DC Northeast",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "2400",
        loadedMiles: "520",
        loadedRpm: "4.62",
        fscAmount: "700",
        rateConfirmationId: rateConfirmation.id,
        driverType: "SHUTTLE",
        pickupNumbers: ["PU-3P-104821", "PU-3P-104821-B"],
        coordinatorNotes: "Slip-seat relay at CDC BH — driver swaps trailer mid-route. Confirm seal numbers match the rate con before delivery.",
        equipmentType: "VAN_53",
        equipmentAccessory: "NONE",
        mgStatusTask: "DONE",
        tmwStatusTask: "DONE",
        scaleBeforeTask: "DONE",
        scaleAfterTask: "DONE",
        deliveryDriver: "K. Tran",
        legs: [
          { legType: "SHUTTLE", driverName: "J. Morales", startCity: "Pittsburgh", startState: "PA", endCity: "Harrisburg", endState: "PA", legMiles: "205", notes: "Shuttle leg to relay yard." },
          { legType: "PTP", driverName: "K. Tran", startCity: "Harrisburg", startState: "PA", endCity: "Reading", endState: "PA", legMiles: "55", notes: null },
          { legType: "DELIVERY", driverName: "K. Tran", startCity: "Reading", startState: "PA", endCity: "Carlisle", endState: "PA", legMiles: "12", notes: "Drop-hook at BigBox DC.", etaMinutesFromNow: -30 }
        ]
      },
      {
        id: "showcase-load-002",
        status: LoadStatus.DISPATCHED,
        dropLotId: "lot-showcase-cdc-bh",
        ref: "3P-104823",
        routeId: "RT-104823",
        shipperName: "Acme Foods LLC",
        pickupCity: "Pittsburgh",
        pickupState: "PA",
        receiverName: "BigBox DC Northeast",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "1750",
        loadedMiles: "400",
        loadedRpm: "4.20",
        fscAmount: "520",
        driverType: "PTP",
        equipmentType: "VAN_48",
        scaleBeforeTask: "DONE",
        mgStatusTask: "DONE",
        legs: [
          { legType: "PTP", driverName: "R. Singh", startCity: "Pittsburgh", startState: "PA", endCity: "Carlisle", endState: "PA", legMiles: "400", notes: "Single-driver power-to-power run." }
        ]
      },
      {
        id: "showcase-load-003",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-cdc-bh",
        ref: "3P-104824",
        routeId: "RT-104824",
        shipperName: "SteelCo Industries",
        pickupCity: "Allentown",
        pickupState: "PA",
        receiverName: "Port Newark CY",
        deliveryCity: "Newark",
        deliveryState: "NJ",
        lineHaulRate: "3100",
        loadedMiles: "180",
        loadedRpm: "4.05",
        fscAmount: "410",
        attentionSeverity: "URGENT",
        attentionNote: "Detention risk at Port Newark — confirm appointment."
      },
      {
        id: "showcase-load-004",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-cdc-ib",
        ref: "3P-104822",
        routeId: "RT-104822",
        shipperName: "FreshCold Logistics",
        pickupCity: "Harrisburg",
        pickupState: "PA",
        receiverName: "Regional Grocery Co",
        deliveryCity: "Reading",
        deliveryState: "PA",
        lineHaulRate: "980",
        loadedMiles: "210",
        loadedRpm: "4.67",
        fscAmount: "280"
      },
      {
        id: "showcase-load-005",
        status: LoadStatus.CANCELED,
        dropLotId: null,
        ref: "3P-104777",
        routeId: "RT-104777",
        shipperName: "Acme Foods LLC",
        pickupCity: "Pittsburgh",
        pickupState: "PA",
        receiverName: "BigBox DC Northeast",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "150",
        loadedMiles: "0",
        loadedRpm: "0",
        fscAmount: "0"
      },
      {
        id: "showcase-load-006",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-ltl",
        driverType: "LTL",
        ref: "3P-104900",
        routeId: "RT-104900",
        shipperName: "PaperSource Mills",
        pickupCity: "Scranton",
        pickupState: "PA",
        receiverName: "Walmart DC 6092",
        deliveryCity: "Pottsville",
        deliveryState: "PA",
        lineHaulRate: "1220",
        loadedMiles: "95",
        loadedRpm: "12.84",
        fscAmount: "120",
        equipmentType: "BOX_TRUCK",
        equipmentAccessory: "NONE",
        coordinatorNotes: "Retail LTL — no fixed drop lot. Deadhead back to CDC unless a backhaul is sourced.",
        legs: [
          { legType: "DELIVERY", driverName: "L. Brooks", startCity: "Scranton", startState: "PA", endCity: "Pottsville", endState: "PA", legMiles: "95", notes: "Single LTL delivery." }
        ]
      },
      // RLY1 (capacity 3) gets 4 loads → demonstrates the over-capacity (n/cap, red) state.
      {
        id: "showcase-load-007",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-rly1",
        brokerId: "broker-showcase-northway",
        ref: "3P-105010",
        routeId: "RT-105010",
        shipperName: "Lakeside Foods",
        pickupCity: "Syracuse",
        pickupState: "NY",
        receiverName: "Carlisle DC",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "1180",
        loadedMiles: "250",
        loadedRpm: "4.72",
        fscAmount: "300"
      },
      {
        id: "showcase-load-008",
        status: LoadStatus.DISPATCHED,
        dropLotId: "lot-showcase-rly1",
        brokerId: "broker-showcase-northway",
        ref: "3P-105011",
        routeId: "RT-105011",
        shipperName: "Northeast Paper",
        pickupCity: "Albany",
        pickupState: "NY",
        receiverName: "Reading Hub",
        deliveryCity: "Reading",
        deliveryState: "PA",
        lineHaulRate: "1320",
        loadedMiles: "300",
        loadedRpm: "4.40",
        fscAmount: "360"
      },
      {
        id: "showcase-load-009",
        status: LoadStatus.PICKED_UP,
        dropLotId: "lot-showcase-rly1",
        brokerId: "broker-showcase-keystone",
        ref: "3P-105012",
        routeId: "RT-105012",
        shipperName: "Hudson Valley Produce",
        pickupCity: "Kingston",
        pickupState: "NY",
        receiverName: "Carlisle DC",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "1090",
        loadedMiles: "240",
        loadedRpm: "4.54",
        fscAmount: "290",
        // Firm delivery appointment ~1h out (picked up, not delivered) → demos
        // the Phase-2 firm-appt escalation alert in the marker/rail/notifications.
        deliveryApptType: "FIRM_APPT",
        firmDeliveryMinutesFromNow: 60
      },
      {
        id: "showcase-load-010",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-rly1",
        brokerId: "broker-showcase-greenline",
        ref: "3P-105013",
        routeId: "RT-105013",
        shipperName: "Empire Beverage",
        pickupCity: "Utica",
        pickupState: "NY",
        receiverName: "Allentown DC",
        deliveryCity: "Allentown",
        deliveryState: "PA",
        lineHaulRate: "1260",
        loadedMiles: "280",
        loadedRpm: "4.50",
        fscAmount: "330"
      },
      {
        id: "showcase-load-011",
        status: LoadStatus.DELIVERED,
        dropLotId: "lot-showcase-rly4",
        podStatus: "UPLOADED",
        ref: "3P-104950",
        routeId: "RT-104950",
        shipperName: "Downeast Seafood",
        pickupCity: "Bangor",
        pickupState: "ME",
        receiverName: "BigBox DC Northeast",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "2100",
        loadedMiles: "480",
        loadedRpm: "4.38",
        fscAmount: "600",
        driverType: "SHUTTLE",
        deliveryDriver: "M. Diaz",
        equipmentType: "VAN_53",
        mgStatusTask: "DONE",
        tmwStatusTask: "DONE",
        scaleBeforeTask: "DONE",
        scaleAfterTask: "DONE",
        coordinatorNotes: "Long-haul from Maine. POD uploaded; awaiting broker confirmation.",
        legs: [
          { legType: "SHUTTLE", driverName: "T. Nguyen", startCity: "Bangor", startState: "ME", endCity: "Worcester", endState: "MA", legMiles: "250", notes: "Relay south." },
          { legType: "DELIVERY", driverName: "M. Diaz", startCity: "Worcester", startState: "MA", endCity: "Carlisle", endState: "PA", legMiles: "230", notes: null }
        ]
      },
      {
        id: "showcase-load-012",
        status: LoadStatus.POD_RECEIVED,
        dropLotId: "lot-showcase-rly5",
        brokerId: "broker-showcase-northway",
        podStatus: "SENT_TO_BROKER",
        ref: "3P-104951",
        routeId: "RT-104951",
        shipperName: "Bay State Mills",
        pickupCity: "Worcester",
        pickupState: "MA",
        receiverName: "Reading Hub",
        deliveryCity: "Reading",
        deliveryState: "PA",
        lineHaulRate: "1450",
        loadedMiles: "330",
        loadedRpm: "4.39",
        fscAmount: "400",
        driverType: "PTP",
        equipmentType: "VAN_53",
        equipmentAccessory: "STRAPS",
        mgStatusTask: "DONE",
        tmwStatusTask: "DONE",
        scaleBeforeTask: "DONE",
        scaleAfterTask: "DONE",
        lumperFeeAmount: "85",
        pricingModel: "FLAT_PLUS_FUEL"
      },
      // Below-target backhaul: high empty share, thin NBY → attention + (Phase 4) below-target dot.
      {
        id: "showcase-load-013",
        status: LoadStatus.BOOKED,
        dropLotId: "lot-showcase-rly2",
        brokerId: "broker-showcase-atlas",
        ref: "3P-105020",
        routeId: "RT-105020",
        shipperName: "Chautauqua Goods",
        pickupCity: "Fairview",
        pickupState: "NY",
        receiverName: "Carlisle DC",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "900",
        loadedMiles: "600",
        loadedRpm: "1.50",
        fscAmount: "250",
        attentionSeverity: "WARN",
        attentionNote: "Below lane target — backhaul margin thin."
      },
      {
        id: "showcase-load-014",
        status: LoadStatus.COMPLETED,
        dropLotId: "lot-showcase-rly3",
        brokerId: "broker-showcase-greenline",
        podStatus: "UPLOADED",
        ref: "3P-104888",
        routeId: "RT-104888",
        shipperName: "Three Rivers Steel",
        pickupCity: "Pittsburgh",
        pickupState: "PA",
        receiverName: "Port Newark CY",
        deliveryCity: "Newark",
        deliveryState: "NJ",
        lineHaulRate: "1380",
        loadedMiles: "320",
        loadedRpm: "4.31",
        fscAmount: "380",
        driverType: "PTP",
        equipmentType: "VAN_53",
        mgStatusTask: "DONE",
        tmwStatusTask: "DONE",
        scaleBeforeTask: "DONE",
        scaleAfterTask: "DONE",
        coordinatorNotes: "Completed and invoiced. Reference for the closed-load view."
      },
      // TONU — truck ordered, shipper canceled at the dock. Exercises isTONU + tonuAmount.
      {
        id: "showcase-load-015",
        status: LoadStatus.CANCELED,
        dropLotId: null,
        brokerId: "broker-showcase-atlas",
        ref: "3P-105030",
        routeId: "RT-105030",
        shipperName: "Keystone Components",
        pickupCity: "Carlisle",
        pickupState: "PA",
        receiverName: "Carlisle DC",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "0",
        loadedMiles: "0",
        loadedRpm: "0",
        fscAmount: "0",
        isTONU: true,
        tonuAmount: "250",
        podStatus: "NOT_REQUESTED",
        attentionSeverity: "WARN",
        attentionNote: "TONU — truck ordered, shipper canceled at the dock. Billing $250.",
        coordinatorNotes: "Driver arrived on time; load pulled by shipper. TONU approved by broker."
      },
      // FAILED load with POD NEEDS_ATTENTION — exercises the failure lane + urgent banner.
      {
        id: "showcase-load-016",
        status: LoadStatus.FAILED,
        dropLotId: "lot-showcase-rly5",
        brokerId: "broker-showcase-keystone",
        ref: "3P-105031",
        routeId: "RT-105031",
        shipperName: "Bay State Mills",
        pickupCity: "Springfield",
        pickupState: "MA",
        receiverName: "Reading Hub",
        deliveryCity: "Reading",
        deliveryState: "PA",
        lineHaulRate: "1400",
        loadedMiles: "310",
        loadedRpm: "4.52",
        fscAmount: "360",
        podStatus: "NEEDS_ATTENTION",
        attentionSeverity: "URGENT",
        attentionNote: "Load failed — refused at receiver for temp excursion. Rework in progress.",
        coordinatorNotes: "Reefer alarm logged en route. Receiver rejected; sourcing salvage buyer.",
        equipmentType: "VAN_53",
        equipmentAccessory: "NONE"
      },
      // Multi-stop consolidation — 4 pickup numbers + 4-leg journey. Heavy drawer test.
      {
        id: "showcase-load-017",
        status: LoadStatus.DISPATCHED,
        dropLotId: "lot-showcase-cdc-hub",
        brokerId: "broker-showcase-northway",
        ref: "3P-105032",
        routeId: "RT-105032",
        shipperName: "Great Lakes Freight Consolidators",
        pickupCity: "Buffalo",
        pickupState: "NY",
        receiverName: "Carlisle DC",
        deliveryCity: "Carlisle",
        deliveryState: "PA",
        lineHaulRate: "2150",
        loadedMiles: "330",
        loadedRpm: "5.40",
        fscAmount: "420",
        driverType: "SHUTTLE",
        pickupNumbers: ["PU-3P-105032-A", "PU-3P-105032-B", "PU-3P-105032-C", "PU-3P-105032-D"],
        coordinatorNotes: "Multi-stop consolidation — four pickup numbers across two yards. Verify each BOL before the relay handoff.",
        equipmentType: "OTHER",
        equipmentOtherText: "Conestoga curtain-side",
        equipmentAccessory: "STRAPS",
        scaleBeforeTask: "DONE",
        deliveryDriver: "P. Okafor",
        legs: [
          { legType: "SHUTTLE", driverName: "S. Romano", startCity: "Buffalo", startState: "NY", endCity: "Syracuse", endState: "NY", legMiles: "150", notes: "Collect pickups A & B." },
          { legType: "SHUTTLE", driverName: "S. Romano", startCity: "Syracuse", startState: "NY", endCity: "Binghamton", endState: "NY", legMiles: "75", notes: "Collect pickups C & D." },
          { legType: "PTP", driverName: "P. Okafor", startCity: "Binghamton", startState: "NY", endCity: "Scranton", endState: "PA", legMiles: "70", notes: "Relay handoff." },
          { legType: "DELIVERY", driverName: "P. Okafor", startCity: "Scranton", startState: "PA", endCity: "Carlisle", endState: "PA", legMiles: "85", notes: "Final drop." }
        ]
      },
      // Flatbed steel with lumper + FLAT_PLUS_FUEL pricing.
      {
        id: "showcase-load-018",
        status: LoadStatus.DELIVERED,
        dropLotId: "lot-showcase-rly3",
        brokerId: "broker-showcase-summit",
        ref: "3P-105033",
        routeId: "RT-105033",
        shipperName: "Three Rivers Steel",
        pickupCity: "Pittsburgh",
        pickupState: "PA",
        receiverName: "Allentown DC",
        deliveryCity: "Allentown",
        deliveryState: "PA",
        lineHaulRate: "1680",
        loadedMiles: "300",
        loadedRpm: "5.60",
        fscAmount: "390",
        driverType: "PTP",
        podStatus: "UPLOADED",
        equipmentType: "FLATBED_OR_STEPDECK",
        equipmentAccessory: "TARPS",
        lumperFeeAmount: "120",
        pricingModel: "FLAT_PLUS_FUEL",
        mgStatusTask: "DONE",
        tmwStatusTask: "DONE",
        scaleBeforeTask: "DONE",
        scaleAfterTask: "DONE",
        coordinatorNotes: "Flatbed steel — tarped. Lumper paid at receiver; receipt attached to POD.",
        legs: [
          { legType: "PTP", driverName: "J. Morales", startCity: "Pittsburgh", startState: "PA", endCity: "Allentown", endState: "PA", legMiles: "300", notes: "Direct flatbed run." }
        ]
      }
    ];

    // Rotation rosters so each load's operations data looks distinct in the
    // drawer rather than every row sharing one driver/truck/commodity.
    const driverRoster = ["J. Morales", "K. Tran", "R. Singh", "L. Brooks", "M. Diaz", "T. Nguyen", "P. Okafor", "S. Romano"];
    const tractorRoster = ["TRK-8821", "TRK-4417", "TRK-9023", "TRK-3360", "TRK-7745"];
    const trailerRoster = ["TRL-2291", "TRL-6680", "TRL-1102", "TRL-5538", "TRL-8814"];
    const commodityRoster = ["Palletized dry goods", "Refrigerated produce", "Steel coils", "Paper rolls", "Canned beverages", "Mixed retail freight"];
    const equipNeedsRoster = ["53' dry van", "48' dry van", "53' reefer", "Flatbed w/ tarps", "Box truck (26')"];
    const pick = (arr, i) => arr[i % arr.length];

    // Rebuild showcase legs deterministically on every run.
    await tx.loadLeg.deleteMany({ where: { loadId: { in: loads.map((l) => l.id) } } });

    for (let i = 0; i < loads.length; i++) {
      const load = loads[i];
      const totalTripMiles = Number(load.loadedMiles) + 28 + 35;
      const emptyMilePct = totalTripMiles === 0 ? "0.0000" : ((28 + 35) / totalTripMiles).toFixed(4);
      const allInRevenue = (Number(load.lineHaulRate) + Number(load.fscAmount) + Number(load.tonuAmount ?? 0)).toFixed(2);

      // Shared payload — used for both update and create so the two never drift.
      const data = {
        regionId: region.id,
        weekIso,
        pickupDate,
        bookingDate,
        status: load.status,
        createdById: user.id,
        dropLotId: load.dropLotId,
        rateConfirmationId: load.rateConfirmationId ?? null,
        brokerId: load.brokerId ?? broker.id,
        routeId: load.routeId,
        loadNumber: load.ref,
        pickupNumber: `PU-${load.ref}`,
        pickupNumbers: load.pickupNumbers ?? [`PU-${load.ref}`],
        threePlRefNumber: load.ref,
        mgStatus: "CLEARED",
        tmwStatus: "ASSIGNED",
        mgStatusTask: load.mgStatusTask ?? "NOT_DONE",
        tmwStatusTask: load.tmwStatusTask ?? "NOT_DONE",
        scaleBeforeTask: load.scaleBeforeTask ?? "NOT_DONE",
        scaleAfterTask: load.scaleAfterTask ?? "NOT_DONE",
        coordinatorNotes: load.coordinatorNotes ?? null,
        pickupDriverAssigned: load.pickupDriverAssigned ?? pick(driverRoster, i),
        deliveryDriver: load.deliveryDriver ?? null,
        tractorTrailer1: load.tractorTrailer1 ?? pick(tractorRoster, i),
        tractorTrailer2: load.tractorTrailer2 ?? pick(trailerRoster, i),
        commodity: load.commodity ?? pick(commodityRoster, i),
        equipmentNeeds: load.equipmentNeeds ?? pick(equipNeedsRoster, i),
        equipmentType: load.equipmentType ?? null,
        equipmentAccessory: load.equipmentAccessory ?? null,
        equipmentOtherText: load.equipmentOtherText ?? null,
        lumperFeeAmount: load.lumperFeeAmount ?? null,
        shipperName: load.shipperName,
        pickupCity: load.pickupCity,
        pickupState: load.pickupState,
        pickupWindow: load.pickupWindow ?? "08:00–12:00",
        receiverName: load.receiverName,
        deliveryCity: load.deliveryCity,
        deliveryState: load.deliveryState,
        deliveryWindow: load.deliveryWindow ?? "14:00–18:00",
        deliveryApptType: load.deliveryApptType ?? null,
        deliveryWindowStart:
          load.firmDeliveryMinutesFromNow != null
            ? new Date(now.getTime() + load.firmDeliveryMinutesFromNow * 60000)
            : null,
        deliveryWindowEnd:
          load.firmDeliveryMinutesFromNow != null
            ? new Date(now.getTime() + load.firmDeliveryMinutesFromNow * 60000)
            : null,
        deliveryTimeZone: load.deliveryApptType ? "America/New_York" : null,
        podStatus: load.podStatus ?? (load.status === LoadStatus.DELIVERED ? "UPLOADED" : "REQUESTED"),
        attentionSeverity: load.attentionSeverity ?? "INFO",
        attentionNote: load.attentionNote ?? null,
        driverType: load.driverType ?? null,
        lineHaulRate: load.lineHaulRate,
        loadedMiles: load.loadedMiles,
        puDeadheadMiles: "28",
        delDeadheadMiles: "35",
        fscApplies: true,
        fscRateUsed: "0.52",
        fscAmount: load.fscAmount,
        lineHaulPricingModel: load.pricingModel ?? "FLAT",
        isTONU: load.isTONU ?? false,
        tonuAmount: load.tonuAmount ?? "0",
        allInRevenue,
        totalTripMiles: String(totalTripMiles),
        negotiableMiles: load.loadedMiles,
        loadedRpm: load.loadedRpm,
        emptyMilePct
      };

      await tx.load.upsert({
        where: { id: load.id },
        update: data,
        create: { id: load.id, ...data }
      });

      if (load.legs && load.legs.length > 0) {
        for (let j = 0; j < load.legs.length; j++) {
          const leg = load.legs[j];
          await tx.loadLeg.create({
            data: {
              loadId: load.id,
              legIndex: j,
              legType: leg.legType,
              driverName: leg.driverName ?? null,
              startCity: leg.startCity ?? null,
              startState: leg.startState ?? null,
              endCity: leg.endCity ?? null,
              endState: leg.endState ?? null,
              legMiles: leg.legMiles ?? null,
              notes: leg.notes ?? null,
              etaAt: leg.etaMinutesFromNow != null ? new Date(now.getTime() + leg.etaMinutesFromNow * 60000) : null,
              arrivalAt: leg.arrivalMinutesFromNow != null ? new Date(now.getTime() + leg.arrivalMinutesFromNow * 60000) : null
            }
          });
        }
      }
    }

    // Weekly KPI showcase baselines sourced from the presentation pack.
    // We anchor them relative to "this week" so demos remain current.
    const snapshotSeeds = [
      {
        week: weekIsoFromDate(addWeeks(bookingDate, -1)), // 4/27-5/1
        loads: 18,
        lineHaulRevenue: "16705.00",
        loadedMiles: "6377.0",
        pickupDeadhead: "672.5",
        deliveryDeadhead: "897.0",
        emptyMilePct: "0.1980",
        totalAllInRevenue: "16705.00",
        fscAmount: "0.00"
      },
      {
        week: weekIsoFromDate(addWeeks(bookingDate, -2)), // 4/20-4/24
        loads: 16,
        lineHaulRevenue: "14014.00",
        loadedMiles: "5387.0",
        pickupDeadhead: "544.0",
        deliveryDeadhead: "729.0",
        emptyMilePct: "0.1910",
        totalAllInRevenue: "18791.50",
        fscAmount: "4777.50"
      },
      {
        week: weekIsoFromDate(addWeeks(bookingDate, -3)), // 4/13-4/17
        loads: 18,
        lineHaulRevenue: "18375.00",
        loadedMiles: "6695.0",
        pickupDeadhead: "913.0",
        deliveryDeadhead: "1191.4",
        emptyMilePct: "0.2390",
        totalAllInRevenue: "18375.00",
        fscAmount: "0.00"
      },
      {
        week: weekIsoFromDate(addWeeks(bookingDate, -4)), // 4/6-4/10
        loads: 24,
        lineHaulRevenue: "12960.00",
        loadedMiles: "6070.3",
        pickupDeadhead: "564.8",
        deliveryDeadhead: "438.3",
        emptyMilePct: "0.1660",
        totalAllInRevenue: "12960.00",
        fscAmount: "0.00"
      },
      {
        week: weekIsoFromDate(addWeeks(bookingDate, -5)), // 3/30-4/3
        loads: 20,
        lineHaulRevenue: "12200.00",
        loadedMiles: "4516.0",
        pickupDeadhead: "599.5",
        deliveryDeadhead: "384.5",
        emptyMilePct: "0.2750",
        totalAllInRevenue: "12200.00",
        fscAmount: "0.00"
      }
    ];

    for (const snap of snapshotSeeds) {
      const totalEmptyMiles = Number(snap.pickupDeadhead) + Number(snap.deliveryDeadhead);
      const totalTripMiles = Number(snap.loadedMiles) + totalEmptyMiles;
      await tx.weekSnapshot.upsert({
        where: {
          regionId_weekIso: {
            regionId: region.id,
            weekIso: snap.week
          }
        },
        update: {
          loadCount: snap.loads,
          lineHaulRevenue: snap.lineHaulRevenue,
          fuelSurchargeAmount: snap.fscAmount,
          totalAllInRevenue: snap.totalAllInRevenue,
          totalLoadedMiles: snap.loadedMiles,
          totalPickupDeadhead: snap.pickupDeadhead,
          totalDeliveryDeadhead: snap.deliveryDeadhead,
          totalEmptyMiles: totalEmptyMiles.toFixed(1),
          totalTripMiles: totalTripMiles.toFixed(1),
          emptyMilePct: snap.emptyMilePct
        },
        create: {
          regionId: region.id,
          weekIso: snap.week,
          loadCount: snap.loads,
          lineHaulRevenue: snap.lineHaulRevenue,
          fuelSurchargeAmount: snap.fscAmount,
          totalAllInRevenue: snap.totalAllInRevenue,
          totalLoadedMiles: snap.loadedMiles,
          totalPickupDeadhead: snap.pickupDeadhead,
          totalDeliveryDeadhead: snap.deliveryDeadhead,
          totalEmptyMiles: totalEmptyMiles.toFixed(1),
          totalTripMiles: totalTripMiles.toFixed(1),
          emptyMilePct: snap.emptyMilePct
        }
      });
    }

    const rules = [
      {
        code: "FRONT_DROP_HOOK",
        severity: RuleSeverity.ACTION_REQUIRED,
        statement: "3PL must guarantee drop-hook at pickup."
      },
      {
        code: "BUFFER_0900",
        severity: RuleSeverity.WARN,
        statement: "PU windows before 09:00 risk HOS conflict."
      }
    ];

    for (const rule of rules) {
      await tx.operationalRule.upsert({
        where: {
          regionId_code: {
            regionId: region.id,
            code: rule.code
          }
        },
        update: {
          severity: rule.severity,
          statement: rule.statement
        },
        create: {
          regionId: region.id,
          code: rule.code,
          severity: rule.severity,
          statement: rule.statement
        }
      });
    }

    // Per-region board tunables so Settings shows live thresholds and the board's
    // Empty%/NBY coloring + alerts fire.
    await tx.regionConfig.upsert({
      where: { regionId: region.id },
      update: { emptyPctAmber: "15", emptyPctRed: "25", emptyPctAlert: "6.5", updatedById: user.id },
      create: { regionId: region.id, emptyPctAmber: "15", emptyPctRed: "25", emptyPctAlert: "6.5", updatedById: user.id }
    });

    // Active LLM provider singleton (no key — write-only key is added via Settings UI),
    // so the Settings page shows a configured provider/model rather than an empty state.
    await tx.llmProviderConfig.upsert({
      where: { id: "default" },
      update: { provider: "anthropic", model: "claude-haiku-4-5", copilotModel: "claude-opus-4-8", isActive: true, updatedById: user.id },
      create: { id: "default", provider: "anthropic", model: "claude-haiku-4-5", copilotModel: "claude-opus-4-8", isActive: true, updatedById: user.id }
    });

    // Audit trail — the seed never wrote audit rows before, so the Audit browser,
    // its filters, and the before/after diff modal had nothing to show. These mirror
    // the entityType/action conventions the app's write paths actually emit.
    const auditSeeds = [
      { id: "audit-showcase-001", entityType: "Lane", entityId: "lane-brookhaven-carlisle", action: "REFERENCE_LANE_SET_TARGET", actorId: user.id, dayOffset: -6, hour: 9, reason: "Q2 DAT RateView refresh", before: { targetRate: "1300.00" }, after: { targetRate: "1450.00" } },
      { id: "audit-showcase-002", entityType: "Broker", entityId: "broker-showcase-keystone", action: "REFERENCE_BROKER_CREATE", actorId: "dev-bypass-user", dayOffset: -6, hour: 11, reason: null, before: null, after: { name: "Keystone Freight Brokers", onboardingStatus: "PENDING", fscDefaultApplies: false } },
      { id: "audit-showcase-003", entityType: "BrokerRep", entityId: "rep-northway-3", action: "REFERENCE_BROKER_REP_CREATE", actorId: user.id, dayOffset: -5, hour: 8, reason: null, before: null, after: { name: "Elena Cho", email: "echo@northwaylogistics.com" } },
      { id: "audit-showcase-004", entityType: "DropLot", entityId: "lot-showcase-rly1", action: "REFERENCE_DROP_LOT_UPDATE", actorId: user.id, dayOffset: -5, hour: 14, reason: "Raised daily capacity for produce season", before: { dailyCapacity: 2 }, after: { dailyCapacity: 3 } },
      { id: "audit-showcase-005", entityType: "Broker", entityId: "broker-showcase-atlas", action: "REFERENCE_BROKER_UPDATE", actorId: "dev-bypass-user", dayOffset: -4, hour: 10, reason: "Repeated TONU disputes", before: { onboardingStatus: "APPROVED" }, after: { onboardingStatus: "BLOCKED" } },
      { id: "audit-showcase-006", entityType: "RateConfirmation", entityId: "rc-showcase-001", action: "UPLOAD_ACCEPTED", actorId: "dev-bypass-user", dayOffset: -4, hour: 13, reason: null, before: null, after: { sourceFileHash: "showcase-rc-hash-001", parseState: "EXTRACTED" } },
      { id: "audit-showcase-007", entityType: "RateConfirmation", entityId: "rc-showcase-001", action: "STATE_TRANSITION", actorId: user.id, dayOffset: -4, hour: 13, reason: "Parsed at 94% confidence", before: { parseState: "EXTRACTED", reviewDecision: "PENDING" }, after: { parseState: "EXTRACTED", reviewDecision: "APPROVED" } },
      { id: "audit-showcase-008", entityType: "Load", entityId: "showcase-load-001", action: "BOARD_MOVE", actorId: user.id, dayOffset: -3, hour: 9, reason: null, before: { dropLotId: "lot-showcase-cdc-ib" }, after: { dropLotId: "lot-showcase-cdc-bh" } },
      { id: "audit-showcase-009", entityType: "Load", entityId: "showcase-load-001", action: "BOARD_STATUS_UPDATE", actorId: user.id, dayOffset: -3, hour: 10, reason: null, before: { status: "DISPATCHED" }, after: { status: "PICKED_UP" } },
      { id: "audit-showcase-010", entityType: "Load", entityId: "showcase-load-005", action: "TONU_MARKED", actorId: "dev-bypass-user", dayOffset: -3, hour: 15, reason: "Shipper canceled after dispatch", before: { isTonu: false }, after: { isTonu: true } },
      { id: "audit-showcase-011", entityType: "Load", entityId: "showcase-load-013", action: "BOARD_FIELD_UPDATE", actorId: user.id, dayOffset: -2, hour: 11, reason: null, before: { attentionSeverity: "INFO" }, after: { attentionSeverity: "WARN", attentionNote: "Below lane target — backhaul margin thin." } },
      { id: "audit-showcase-012", entityType: "RegionConfig", entityId: region.id, action: "SET_BOARD_THRESHOLDS", actorId: "dev-bypass-user", dayOffset: -2, hour: 16, reason: "Tightened empty-mile alert", before: { emptyPctAlert: "8.0" }, after: { emptyPctAlert: "6.5" } },
      { id: "audit-showcase-013", entityType: "LlmProviderConfig", entityId: "default", action: "SET_LLM_SETTINGS", actorId: "dev-bypass-user", dayOffset: -1, hour: 9, reason: null, before: { model: "claude-haiku-4-5" }, after: { model: "claude-haiku-4-5", copilotModel: "claude-opus-4-8" } },
      { id: "audit-showcase-014", entityType: "Lane", entityId: "lane-westbrook-carlisle", action: "REFERENCE_LANE_DELETE", actorId: user.id, dayOffset: -1, hour: 14, reason: "Duplicate of Pittsburgh lane", before: { originCity: "Westbrook", targetRate: "1350.00" }, after: null },
      { id: "audit-showcase-015", entityType: "Load", entityId: "showcase-load-011", action: "BOARD_STATUS_UPDATE", actorId: user.id, dayOffset: 0, hour: 8, reason: null, before: { status: "PICKED_UP" }, after: { status: "DELIVERED" } }
    ];

    for (const a of auditSeeds) {
      const ts = addDays(bookingDate, a.dayOffset);
      ts.setHours(a.hour, 0, 0, 0);
      await tx.auditLog.upsert({
        where: { id: a.id },
        update: { entityType: a.entityType, entityId: a.entityId, action: a.action, actorId: a.actorId, timestamp: ts, reason: a.reason, beforeValue: a.before, afterValue: a.after },
        create: { id: a.id, entityType: a.entityType, entityId: a.entityId, action: a.action, actorId: a.actorId, timestamp: ts, reason: a.reason, beforeValue: a.before, afterValue: a.after }
      });
    }
  }, { maxWait: 20000, timeout: 120000 });

  console.log("Showcase seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
