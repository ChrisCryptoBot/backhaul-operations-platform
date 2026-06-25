import fs from "node:fs";
import crypto from "node:crypto";
import { PrismaClient, ParseState, ReviewDecision, LoadStatus } from "@prisma/client";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    args[key] = value;
  }
  return args;
}

function normalize(value) {
  return (value ?? "").toString().trim().toUpperCase();
}

function splitCityState(value) {
  if (!value || typeof value !== "string") return { city: null, state: null };
  const text = value.trim();
  if (!text) return { city: null, state: null };
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null };
  if (parts.length === 1) return { city: parts[0], state: null };
  return { city: parts[0], state: parts[1].slice(0, 2).toUpperCase() };
}

function laneLabelFromLoad(load) {
  const pu = splitCityState(load.pickupCityState);
  const del = splitCityState(load.deliveryCityState);
  return `${pu.city ?? "Unknown"}, ${pu.state ?? "??"} → ${del.city ?? "Unknown"}, ${del.state ?? "??"}`;
}

function mapStatus(statusText, issueText) {
  const combined = `${statusText ?? ""} ${issueText ?? ""}`.toUpperCase();
  if (combined.includes("FAILED")) return LoadStatus.FAILED;
  if (combined.includes("CANCEL")) return LoadStatus.CANCELED;
  if (combined.includes("DONE")) return LoadStatus.COMPLETED;
  if (combined.includes("LOADED SET TO DEL") || combined.includes("SET TO DEL")) return LoadStatus.DISPATCHED;
  return LoadStatus.BOOKED;
}

function extractLotCode(dropLotName) {
  const match = /\(([A-Z0-9]{3,6})\)/i.exec(dropLotName ?? "");
  return match ? match[1].toUpperCase() : null;
}

function parseWeekFromIsoDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${week.toString().padStart(2, "0")}`;
}

function buildWeeklyTotals(loads) {
  const byWeek = new Map();
  for (const load of loads) {
    const week = load.weekIso;
    const bucket = byWeek.get(week) ?? {
      loadCount: 0,
      lineHaulRevenue: 0,
      fuelSurchargeAmount: 0,
      totalLoadedMiles: 0,
      totalPickupDeadhead: 0,
      totalDeliveryDeadhead: 0,
      totalEmptyMiles: 0,
      totalTripMiles: 0,
      totalAllInRevenue: 0,
      totalTonuAmount: 0
    };
    bucket.loadCount += 1;
    bucket.lineHaulRevenue += Number(load.lineHaulRate ?? 0);
    bucket.totalLoadedMiles += Number(load.loadedMiles ?? 0);
    bucket.totalPickupDeadhead += Number(load.puDeadheadMiles ?? 0);
    bucket.totalDeliveryDeadhead += Number(load.delDeadheadMiles ?? 0);
    bucket.totalAllInRevenue += Number(load.lineHaulRate ?? 0);
    byWeek.set(week, bucket);
  }
  for (const bucket of byWeek.values()) {
    bucket.totalEmptyMiles = bucket.totalPickupDeadhead + bucket.totalDeliveryDeadhead;
    bucket.totalTripMiles = bucket.totalLoadedMiles + bucket.totalEmptyMiles;
    bucket.emptyMilePct = bucket.totalTripMiles > 0 ? bucket.totalEmptyMiles / bucket.totalTripMiles : null;
    const floorMiles = bucket.totalLoadedMiles + bucket.totalPickupDeadhead;
    bucket.inboundRevenue = 0;
    bucket.inboundLoadedMiles = 0;
    bucket.mileMaxMissingInbound = true;
    bucket.mileMaxRpm = floorMiles > 0 ? bucket.lineHaulRevenue / floorMiles : null;
  }
  return byWeek;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = args.input;
  if (!inputPath) {
    throw new Error("Missing --input path to parsed JSON payload.");
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const parsedLoads = payload.loads ?? [];
  const targetByCode = payload.targetByCode ?? {};
  const emptyPctByWeek = payload.emptyMilePctByWeek ?? {};

  const region =
    (await prisma.region.findFirst({ where: { code: "NE" } })) ??
    (await prisma.region.findFirst());
  if (!region) {
    throw new Error("No region found in database.");
  }

  const actorId = "blueprint-import-bot";
  await prisma.user.upsert({
    where: { id: actorId },
    update: { email: "blueprint-import-bot@local.backhaul", name: "Blueprint Import Bot" },
    create: { id: actorId, email: "blueprint-import-bot@local.backhaul", name: "Blueprint Import Bot" }
  });

  const dropLots = await prisma.dropLot.findMany({ where: { regionId: region.id } });
  const lotByName = new Map(dropLots.map((lot) => [normalize(lot.name), lot]));
  const lotByCode = new Map(dropLots.map((lot) => [normalize(lot.code), lot]));

  const existingBrokers = await prisma.broker.findMany({ where: { regionId: region.id, deletedAt: null } });
  const brokerByName = new Map(existingBrokers.map((broker) => [normalize(broker.name), broker]));

  const weeksToImport = Array.from(new Set(parsedLoads.map((load) => load.weekIso).concat(Object.keys(emptyPctByWeek))));
  // Replace board/KPI data for imported weeks with document-backed rows.
  await prisma.load.updateMany({
    where: {
      regionId: region.id,
      weekIso: { in: weeksToImport },
      deletedAt: null
    },
    data: { deletedAt: new Date() }
  });
  await prisma.load.updateMany({
    where: {
      regionId: region.id,
      weekIso: { in: weeksToImport },
      createdById: actorId,
      deletedAt: null
    },
    data: { deletedAt: new Date() }
  });

  const importedLoads = [];
  for (const raw of parsedLoads) {
    const weekIso = raw.weekIso || parseWeekFromIsoDate(raw.pickupDate);
    const sourceKey = `${raw.sheetName}:${raw.sheetRow}:${raw.ref}`;
    const sourceHash = crypto.createHash("sha256").update(sourceKey).digest("hex");
    const idempotencyKey = `blueprint-import:${sourceKey}`;

    const pickupDate = new Date(`${raw.pickupDate}T12:00:00.000Z`);
    const deliveryDateMatch = /(\d{1,2})\/(\d{1,2})\/(\d{2})/.exec(raw.deliveryWindow ?? "");
    const deliveryDate = deliveryDateMatch
      ? new Date(`20${deliveryDateMatch[3]}-${deliveryDateMatch[1].padStart(2, "0")}-${deliveryDateMatch[2].padStart(2, "0")}T12:00:00.000Z`)
      : null;

    let brokerId = null;
    const brokerName = (raw.brokerName ?? "").trim();
    if (brokerName) {
      const brokerKey = normalize(brokerName);
      let broker = brokerByName.get(brokerKey) ?? null;
      if (!broker) {
        broker = await prisma.broker.create({
          data: {
            regionId: region.id,
            name: brokerName
          }
        });
        brokerByName.set(brokerKey, broker);
      }
      brokerId = broker.id;
    }

    const lotCode = extractLotCode(raw.dropLot);
    const lot = (lotCode && lotByCode.get(normalize(lotCode))) || lotByName.get(normalize(raw.dropLot ?? ""));
    const dropLotId = lot?.id ?? null;
    const pickup = splitCityState(raw.pickupCityState);
    const delivery = splitCityState(raw.deliveryCityState);

    const rateConfirmation = await prisma.rateConfirmation.upsert({
      where: { idempotencyKey },
      update: {
        regionId: region.id,
        weekIso,
        sourceFileUrl: `blueprint://spreadsheet/${encodeURIComponent(raw.sheetName)}#row-${raw.sheetRow}`,
        sourceFileHash: sourceHash,
        parseState: ParseState.EXTRACTED,
        reviewDecision: ReviewDecision.APPROVED,
        contractVersion: "v1",
        extractedPayload: raw
      },
      create: {
        regionId: region.id,
        weekIso,
        sourceFileUrl: `blueprint://spreadsheet/${encodeURIComponent(raw.sheetName)}#row-${raw.sheetRow}`,
        sourceFileHash: sourceHash,
        idempotencyKey,
        parseState: ParseState.EXTRACTED,
        reviewDecision: ReviewDecision.APPROVED,
        reviewedAt: new Date(),
        reviewedById: actorId,
        contractVersion: "v1",
        extractedPayload: raw
      }
    });

    const existingLoad = await prisma.load.findFirst({
      where: {
        rateConfirmationId: rateConfirmation.id
      }
    });

    const baseLoadData = {
      regionId: region.id,
      weekIso,
      pickupDate,
      bookingDate: pickupDate,
      status: mapStatus(raw.statusText, raw.issueText),
      createdById: actorId,
      dropLotId,
      brokerId,
      routeId: raw.routeId || null,
      loadNumber: raw.loadNumber || null,
      pickupNumber: raw.pickupNumber || null,
      pickupNumbers: raw.pickupNumber ? [raw.pickupNumber] : [],
      threePlRefNumber: raw.ref || null,
      shipperName: raw.shipperName || null,
      pickupCity: pickup.city,
      pickupState: pickup.state,
      pickupWindow: raw.pickupWindow || null,
      receiverName: raw.receiverName || null,
      deliveryCity: delivery.city,
      deliveryState: delivery.state,
      deliveryWindow: raw.deliveryWindow || null,
      deliveryDate,
      pickupDriverAssigned: raw.driverAssignment || null,
      commodity: raw.commodity || null,
      equipmentNeeds: raw.equipmentNeeds || null,
      coordinatorNotes: raw.statusText || null,
      lineHaulRate: raw.lineHaulRate,
      loadedMiles: raw.loadedMiles,
      puDeadheadMiles: raw.puDeadheadMiles,
      delDeadheadMiles: raw.delDeadheadMiles,
      fscApplies: false,
      fscAmount: 0,
      tonuAmount: 0,
      allInRevenue: raw.lineHaulRate,
      deletedAt: null
    };

    if (existingLoad) {
      await prisma.load.update({
        where: { id: existingLoad.id },
        data: baseLoadData
      });
    } else {
      await prisma.load.create({
        data: {
          ...baseLoadData,
          rateConfirmationId: rateConfirmation.id
        }
      });
    }

    importedLoads.push({
      ...raw,
      weekIso,
      dropLotCode: lotCode,
      lineHaulRate: Number(raw.lineHaulRate),
      loadedMiles: Number(raw.loadedMiles),
      puDeadheadMiles: Number(raw.puDeadheadMiles),
      delDeadheadMiles: Number(raw.delDeadheadMiles),
      laneLabel: laneLabelFromLoad(raw)
    });
  }

  const totalsByWeek = buildWeeklyTotals(importedLoads);
  const marketRatesByWeek = new Map();
  for (const load of importedLoads) {
    const weekBucket = marketRatesByWeek.get(load.weekIso) ?? {};
    const target = load.dropLotCode ? targetByCode[load.dropLotCode] : null;
    if (target) {
      weekBucket[load.laneLabel] = target;
    }
    marketRatesByWeek.set(load.weekIso, weekBucket);
  }

  for (const week of weeksToImport) {
    const totals = totalsByWeek.get(week) ?? {
      loadCount: 0,
      lineHaulRevenue: 0,
      fuelSurchargeAmount: 0,
      totalLoadedMiles: 0,
      totalPickupDeadhead: 0,
      totalDeliveryDeadhead: 0,
      totalEmptyMiles: 0,
      totalTripMiles: 0,
      totalAllInRevenue: 0,
      totalTonuAmount: 0,
      emptyMilePct: null,
      inboundRevenue: 0,
      inboundLoadedMiles: 0,
      mileMaxMissingInbound: true,
      mileMaxRpm: null
    };
    const existingSnapshot = await prisma.weekSnapshot.findUnique({
      where: { regionId_weekIso: { regionId: region.id, weekIso: week } }
    });
    let notes = {};
    let marketRates = {};
    if (existingSnapshot?.laneIssueNotes && typeof existingSnapshot.laneIssueNotes === "object") {
      const raw = existingSnapshot.laneIssueNotes;
      if (raw.notes && typeof raw.notes === "object") {
        notes = raw.notes;
      } else {
        notes = raw;
      }
      if (raw.marketRates && typeof raw.marketRates === "object") {
        marketRates = raw.marketRates;
      }
    }
    marketRates = { ...marketRates, ...(marketRatesByWeek.get(week) ?? {}) };

    const emptyPctOverride = emptyPctByWeek[week];
    const emptyMilePct = Number.isFinite(emptyPctOverride)
      ? Number(emptyPctOverride) / 100
      : totals.emptyMilePct;

    await prisma.weekSnapshot.upsert({
      where: { regionId_weekIso: { regionId: region.id, weekIso: week } },
      update: {
        loadCount: totals.loadCount,
        lineHaulRevenue: totals.lineHaulRevenue,
        fuelSurchargeAmount: totals.fuelSurchargeAmount,
        totalLoadedMiles: totals.totalLoadedMiles,
        totalPickupDeadhead: totals.totalPickupDeadhead,
        totalDeliveryDeadhead: totals.totalDeliveryDeadhead,
        totalEmptyMiles: totals.totalEmptyMiles,
        totalTripMiles: totals.totalTripMiles,
        totalAllInRevenue: totals.totalAllInRevenue,
        totalTonuAmount: totals.totalTonuAmount,
        emptyMilePct,
        inboundRevenue: 0,
        inboundLoadedMiles: 0,
        mileMaxMissingInbound: true,
        mileMaxRpm: totals.mileMaxRpm,
        laneIssueNotes: {
          notes,
          marketRates
        },
        computedAt: new Date()
      },
      create: {
        regionId: region.id,
        weekIso: week,
        loadCount: totals.loadCount,
        lineHaulRevenue: totals.lineHaulRevenue,
        fuelSurchargeAmount: totals.fuelSurchargeAmount,
        totalLoadedMiles: totals.totalLoadedMiles,
        totalPickupDeadhead: totals.totalPickupDeadhead,
        totalDeliveryDeadhead: totals.totalDeliveryDeadhead,
        totalEmptyMiles: totals.totalEmptyMiles,
        totalTripMiles: totals.totalTripMiles,
        totalAllInRevenue: totals.totalAllInRevenue,
        totalTonuAmount: totals.totalTonuAmount,
        emptyMilePct,
        inboundRevenue: 0,
        inboundLoadedMiles: 0,
        mileMaxMissingInbound: true,
        mileMaxRpm: totals.mileMaxRpm,
        laneIssueNotes: {
          notes: {},
          marketRates
        }
      }
    });
  }

  console.log(
    JSON.stringify(
      {
        region: region.code,
        weeksImported: weeksToImport.sort(),
        loadRowsImported: importedLoads.length,
        weeklyTargetsApplied: Array.from(marketRatesByWeek.entries()).map(([week, rates]) => ({
          week,
          laneCount: Object.keys(rates).length
        }))
      },
      null,
      2
    )
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
