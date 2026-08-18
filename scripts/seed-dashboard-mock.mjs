import { PrismaClient, LoadStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Fills the KPI Dashboard for the CURRENT ISO week with rich mock data so every
// section renders: headline cards + WoW, lane scorecard (target + DAT market +
// variance + notes), rate & market variance histograms, shuttle empty-mile
// leaderboard, controllable-vs-expected deadhead split, OTD/OTP/firm-appt
// reliability (with on-time / late / unverified spread), cancel-vs-reschedule
// disruption breakdown, WoW growth, and a 12-week trend history.
//
// Idempotent: everything it creates is prefixed `mock-kpi-` and wiped first.
// Targets the existing Phase-1 region (code NE) and its real Leesport lanes.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

function weekIsoFromDate(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
function addDays(date, days) {
  const n = new Date(date);
  n.setDate(n.getDate() + days);
  return n;
}
function addWeeks(date, weeks) {
  return addDays(date, weeks * 7);
}
const money = (n) => n.toFixed(2);
const miles = (n) => n.toFixed(1);

// Lane hub is Leesport, PA. Origins + target/DAT market rate + trip geometry.
// datRate is the external DAT benchmark (distinct from the internal targetRate).
const LANES = [
  { city: "Hermon", state: "ME", label: "Hermon, ME → Leesport, PA", lot: "lot-showcase-dshe", target: 1700, dat: 1750, loaded: 620 },
  { city: "Holland", state: "MA", label: "Holland, MA → Leesport, PA", lot: "lot-showcase-ayho", target: 700, dat: 720, loaded: 300 },
  { city: "Baldwinsville", state: "NY", label: "Baldwinsville, NY → Leesport, PA", lot: "lot-showcase-gelba", target: 1150, dat: 1200, loaded: 265 },
  { city: "Jamestown", state: "NY", label: "Jamestown, NY → Leesport, PA", lot: "lot-showcase-anlja", target: 1300, dat: 1280, loaded: 430 },
  { city: "Warrendale", state: "PA", label: "Warrendale, PA → Leesport, PA", lot: "lot-showcase-ztwa", target: 1350, dat: 1400, loaded: 300 }
];

const SHUTTLE_DRIVERS = ["J. Morales", "K. Tran", "R. Singh", "M. Diaz", "T. Nguyen", "P. Okafor"];
const PTP_DRIVERS = ["L. Brooks", "S. Romano", "A. Whitfield"];

// Per-load rate delta vs lane target (cycled) → spreads the rate-variance histogram.
const RATE_DELTAS = [-250, -150, -60, 0, 90, 180, 320, -110, 40];
// Per-load market delta vs DAT (cycled, offset) → spreads the market-variance histogram.
const MARKET_DELTAS = [-180, -40, 60, 140, -260, 210, -90, 30, 120];
// Deadhead pairs (pu, del) cycled — shuttles carry the bigger controllable radius.
const SHUTTLE_DH = [
  [42, 30], [65, 22], [88, 40], [120, 18], [55, 35], [150, 28], [38, 44], [95, 20]
];
const PTP_DH = [[18, 12], [25, 15], [30, 10]];

async function main() {
  const now = new Date();
  const bookingDate = new Date(now);
  bookingDate.setHours(9, 0, 0, 0);
  const weekIso = weekIsoFromDate(bookingDate);

  await prisma.$transaction(
    async (tx) => {
      const region = await tx.region.findUnique({ where: { code: "NE" }, select: { id: true } });
      if (!region) throw new Error("Region NE not found — run the base seed first.");
      const regionId = region.id;

      const user = await tx.user.upsert({
        where: { id: "dev-bypass-user" },
        update: {},
        create: { id: "dev-bypass-user", email: "dev-bypass@local.dev", name: "Dev Bypass" }
      });

      // Wipe prior mock rows so re-runs stay deterministic.
      const priorMock = await tx.load.findMany({ where: { id: { startsWith: "mock-kpi-" } }, select: { id: true } });
      const priorIds = priorMock.map((l) => l.id);
      if (priorIds.length > 0) {
        await tx.loadDisruptionEvent.deleteMany({ where: { loadId: { in: priorIds } } });
        await tx.loadLeg.deleteMany({ where: { loadId: { in: priorIds } } });
        await tx.load.deleteMany({ where: { id: { in: priorIds } } });
      }

      // ── Current-week loads ────────────────────────────────────────────────
      const loads = [];
      let seq = 0;
      const pushLoad = (spec) => loads.push(spec);

      // 3 loads per real lane (SHUTTLE-heavy), rates/deadhead cycled for spread.
      LANES.forEach((lane, laneIdx) => {
        for (let k = 0; k < 3; k++) {
          const i = seq++;
          const isShuttle = k < 2; // 2 shuttle + 1 PTP per lane
          const dh = isShuttle ? SHUTTLE_DH[i % SHUTTLE_DH.length] : PTP_DH[i % PTP_DH.length];
          const rate = Math.max(150, lane.target + RATE_DELTAS[i % RATE_DELTAS.length]);
          const market = Math.max(150, lane.dat + MARKET_DELTAS[i % MARKET_DELTAS.length]);
          // Reliability spread: ~78% on-time, ~13% late, ~9% unverified.
          const rel = i % 8 === 3 || i % 8 === 6 ? "LATE" : i % 8 === 7 ? "UNVERIFIED" : "ONTIME";
          const firm = i % 5 === 0; // ~1 in 5 firm appointments
          const shuttleDriver = SHUTTLE_DRIVERS[i % SHUTTLE_DRIVERS.length];
          const ptpDriver = PTP_DRIVERS[i % PTP_DRIVERS.length];
          const deliveryDriver = isShuttle ? SHUTTLE_DRIVERS[(i + 3) % SHUTTLE_DRIVERS.length] : ptpDriver;
          pushLoad({
            laneIdx,
            lane,
            isShuttle,
            driverType: isShuttle ? "SHUTTLE" : "PTP",
            shuttleDriver,
            deliveryDriver,
            rate,
            market,
            puDh: dh[0],
            delDh: dh[1],
            rel,
            firm,
            status: k === 2 ? LoadStatus.POD_RECEIVED : LoadStatus.DELIVERED
          });
        }
      });

      // A couple of LTL loads (retail, no shuttle) for driver-type variety.
      [0, 1].forEach((k) => {
        const i = seq++;
        pushLoad({
          laneIdx: 99,
          lane: { city: "Scranton", state: "PA", label: "LTL (ALL CITIES), NA → Leesport, PA", lot: "lot-showcase-ltl", target: 1200, dat: 1250, loaded: 110 },
          isShuttle: false,
          driverType: "LTL",
          shuttleDriver: null,
          deliveryDriver: PTP_DRIVERS[i % PTP_DRIVERS.length],
          rate: 1200 + (k === 0 ? 120 : -80),
          market: 1250 + (k === 0 ? 40 : -60),
          puDh: 14,
          delDh: 9,
          rel: k === 0 ? "ONTIME" : "LATE",
          firm: false,
          status: LoadStatus.DELIVERED
        });
      });

      const activeLoadIds = [];
      let idx = 0;
      for (const l of loads) {
        const id = `mock-kpi-w-${String(idx).padStart(2, "0")}`;
        idx += 1;
        activeLoadIds.push(id);
        const loaded = l.lane.loaded;
        const totalTrip = loaded + l.puDh + l.delDh;
        const emptyPct = totalTrip === 0 ? 0 : (l.puDh + l.delDh) / totalTrip;
        const fsc = Math.round(l.rate * 0.13);
        const allIn = l.rate + fsc;

        // Delivery window ends mid-week; arrival lands on-time / late / unverified.
        const windowEnd = new Date(bookingDate);
        windowEnd.setHours(15 + (idx % 4), 0, 0, 0);
        const pickupEnd = new Date(bookingDate);
        pickupEnd.setHours(9 + (idx % 3), 0, 0, 0);
        const deliveryArrival =
          l.rel === "UNVERIFIED"
            ? null
            : new Date(windowEnd.getTime() + (l.rel === "LATE" ? 95 : -40) * 60000);
        const pickupArrival =
          l.rel === "UNVERIFIED" ? null : new Date(pickupEnd.getTime() + (idx % 7 === 0 ? 50 : -25) * 60000);

        const data = {
          regionId,
          weekIso,
          pickupDate: bookingDate,
          bookingDate,
          status: l.status,
          createdById: user.id,
          dropLotId: l.lane.lot,
          loadNumber: `MK-${5200 + idx}`,
          pickupNumber: `PU-MK-${5200 + idx}`,
          pickupNumbers: [`PU-MK-${5200 + idx}`],
          threePlRefNumber: `MK-${5200 + idx}`,
          shipperName: "Ashley Furniture",
          receiverName: "Leesport DC",
          pickupCity: l.lane.city,
          pickupState: l.lane.state,
          deliveryCity: "Leesport",
          deliveryState: "PA",
          pickupWindow: "08:00–12:00",
          deliveryWindow: "14:00–18:00",
          pickupWindowEnd: pickupEnd,
          deliveryWindowEnd: windowEnd,
          deliveryApptType: l.firm ? "FIRM_APPT" : "OPEN_WINDOW",
          deliveryTimeZone: "America/New_York",
          pickupTimeZone: "America/New_York",
          podStatus: l.status === LoadStatus.DELIVERED ? "UPLOADED" : "SENT_TO_BROKER",
          driverType: l.driverType,
          deliveryDriver: l.deliveryDriver,
          pickupDriverAssigned: l.shuttleDriver ?? l.deliveryDriver,
          lineHaulRate: money(l.rate),
          marketRate: money(l.market),
          loadedMiles: miles(loaded),
          puDeadheadMiles: miles(l.puDh),
          delDeadheadMiles: miles(l.delDh),
          fscApplies: true,
          fscRateUsed: "0.52",
          fscAmount: money(fsc),
          isTONU: false,
          tonuAmount: "0",
          allInRevenue: money(allIn),
          totalTripMiles: miles(totalTrip),
          negotiableMiles: miles(loaded),
          loadedRpm: money(l.rate / loaded),
          emptyMilePct: emptyPct.toFixed(4),
          attentionSeverity: "INFO"
        };

        await tx.load.create({ data: { id, ...data } });

        // Legs: shuttle run then final delivery (both with arrival timestamps), so
        // the shuttle leaderboard, deadhead split, and OTD/OTP all have inputs.
        const legs = [];
        if (l.isShuttle) {
          legs.push({
            legType: "SHUTTLE",
            driverName: l.shuttleDriver,
            startCity: l.lane.city,
            startState: l.lane.state,
            endCity: "Relay Yard",
            endState: "PA",
            legMiles: miles(loaded * 0.6),
            arrivalAt: pickupArrival
          });
          legs.push({
            legType: "DELIVERY",
            driverName: l.deliveryDriver,
            startCity: "Relay Yard",
            startState: "PA",
            endCity: "Leesport",
            endState: "PA",
            legMiles: miles(loaded * 0.4),
            arrivalAt: deliveryArrival
          });
        } else {
          legs.push({
            legType: "PTP",
            driverName: l.deliveryDriver,
            startCity: l.lane.city,
            startState: l.lane.state,
            endCity: "Leesport",
            endState: "PA",
            legMiles: miles(loaded * 0.9),
            arrivalAt: pickupArrival
          });
          legs.push({
            legType: "DELIVERY",
            driverName: l.deliveryDriver,
            startCity: "Leesport",
            startState: "PA",
            endCity: "Leesport",
            endState: "PA",
            legMiles: miles(loaded * 0.1),
            arrivalAt: deliveryArrival
          });
        }
        for (let j = 0; j < legs.length; j++) {
          await tx.loadLeg.create({ data: { loadId: id, legIndex: j, ...legs[j] } });
        }
      }

      // ── Disruption events (cancel vs reschedule) for the current week ──────
      // Two dedicated cancels + reschedules attached to real loads so the
      // Phase-3 breakdown shows a populated 9-reason table.
      const disruptions = [
        { kind: "CANCEL", reason: "CARRIER_NO_SHOW", detail: "Carrier never showed at origin." },
        { kind: "CANCEL", reason: "CARRIER_NO_SHOW", detail: "Second no-show, same broker." },
        { kind: "CANCEL", reason: "LOAD_PULLED", detail: "Shipper pulled the load pre-dispatch." },
        { kind: "CANCEL", reason: "EQUIPMENT_ISSUE", detail: "Reefer down at yard." },
        { kind: "CANCEL", reason: "RATE_BILLING_DISPUTE", detail: "Broker would not honor booked rate." },
        { kind: "RESCHEDULE", reason: "PARTY_RESCHEDULE", detail: "Receiver moved appt to next day." },
        { kind: "RESCHEDULE", reason: "PARTY_RESCHEDULE", detail: "Shipper pushed pickup 4h." },
        { kind: "RESCHEDULE", reason: "NO_DOCK_TIME", detail: "No dock slot at DC." },
        { kind: "RESCHEDULE", reason: "WEATHER_ROAD", detail: "I-80 closure, snow." },
        { kind: "RESCHEDULE", reason: "CARRIER_LATE_OR_NOT_EMPTY", detail: "Carrier not empty in time." }
      ];
      for (let d = 0; d < disruptions.length; d++) {
        const loadId = activeLoadIds[d % activeLoadIds.length];
        await tx.loadDisruptionEvent.create({
          data: {
            id: `mock-kpi-dis-${String(d).padStart(2, "0")}`,
            loadId,
            regionId,
            weekIso,
            kind: disruptions[d].kind,
            reason: disruptions[d].reason,
            detail: disruptions[d].detail,
            actorId: user.id
          }
        });
      }

      // ── Current-week snapshot (drives headline cards) ─────────────────────
      // Aggregate the active loads so the cards agree with the lane scorecard.
      let sumLine = 0, sumFsc = 0, sumLoaded = 0, sumPu = 0, sumDel = 0;
      for (const l of loads) {
        sumLine += l.rate;
        sumFsc += Math.round(l.rate * 0.13);
        sumLoaded += l.lane.loaded;
        sumPu += l.puDh;
        sumDel += l.delDh;
      }
      const sumEmpty = sumPu + sumDel;
      const sumTrip = sumLoaded + sumEmpty;
      const datRatesForWeek = Object.fromEntries(LANES.map((l) => [l.label, String(l.dat)]));
      datRatesForWeek["LTL (ALL CITIES), NA → Leesport, PA"] = "1250";
      const laneNotes = {
        "Hermon, ME → Leesport, PA": "Long-haul from Maine; watch HOS on the shuttle relay.",
        "Holland, MA → Leesport, PA": "Soft market this week — several bookings under target.",
        "Warrendale, PA → Leesport, PA": "Strong lane, consistently above DAT."
      };

      // Full 12-week trend history, W-11 … current. Current week uses the real
      // aggregate above; prior weeks are shaped to trend gently.
      const history = [];
      for (let w = 11; w >= 1; w--) {
        const wk = weekIsoFromDate(addWeeks(bookingDate, -w));
        const loadCount = 16 + ((w * 3) % 9); // 16..24 wandering
        const emptyPct = 0.16 + ((w % 5) * 0.022); // 16%..24.8%
        const loaded = loadCount * 340;
        const empty = loaded * (emptyPct / (1 - emptyPct));
        const pu = empty * 0.58;
        const del = empty - pu;
        const line = loadCount * (1100 + ((w * 37) % 260));
        const fscW = Math.round(line * 0.11);
        const tonuW = w % 4 === 0 ? 250 : w % 3 === 0 ? 150 : 0;
        const mileMax = 2.5 + ((w % 6) * 0.12);
        history.push({
          weekIso: wk,
          loadCount,
          lineHaulRevenue: money(line),
          fuelSurchargeAmount: money(fscW),
          totalTonuAmount: money(tonuW),
          totalAllInRevenue: money(line + fscW + tonuW),
          totalLoadedMiles: miles(loaded),
          totalPickupDeadhead: miles(pu),
          totalDeliveryDeadhead: miles(del),
          totalEmptyMiles: miles(empty),
          totalTripMiles: miles(loaded + empty),
          emptyMilePct: emptyPct.toFixed(4),
          mileMaxRpm: mileMax.toFixed(4),
          mileMaxMissingInbound: false,
          laneIssueNotes: null
        });
      }
      // Current week snapshot.
      history.push({
        weekIso,
        loadCount: loads.length,
        lineHaulRevenue: money(sumLine),
        fuelSurchargeAmount: money(sumFsc),
        totalTonuAmount: "0.00",
        totalAllInRevenue: money(sumLine + sumFsc),
        totalLoadedMiles: miles(sumLoaded),
        totalPickupDeadhead: miles(sumPu),
        totalDeliveryDeadhead: miles(sumDel),
        totalEmptyMiles: miles(sumEmpty),
        totalTripMiles: miles(sumTrip),
        emptyMilePct: (sumEmpty / sumTrip).toFixed(4),
        mileMaxRpm: (sumLine / sumLoaded).toFixed(4),
        mileMaxMissingInbound: false,
        laneIssueNotes: { notes: laneNotes, marketRates: {}, datRates: datRatesForWeek }
      });

      for (const snap of history) {
        const { weekIso: wk, laneIssueNotes, ...rest } = snap;
        await tx.weekSnapshot.upsert({
          where: { regionId_weekIso: { regionId, weekIso: wk } },
          update: { ...rest, laneIssueNotes: laneIssueNotes ?? undefined },
          create: { regionId, weekIso: wk, ...rest, laneIssueNotes: laneIssueNotes ?? undefined }
        });
      }

      console.log(`Seeded ${loads.length} loads + ${disruptions.length} disruptions for ${weekIso}, plus ${history.length} weekly snapshots.`);
    },
    { maxWait: 20000, timeout: 120000 }
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
