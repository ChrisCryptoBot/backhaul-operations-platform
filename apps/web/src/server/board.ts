import { LoadStatus, Prisma } from "@prisma/client";
import { runInRegionScope } from "@/lib/db";
import type { BoardLoadRow, BoardResponse, BoardSection } from "@/lib/board-types";
import { safeDivideDecimal } from "@/lib/decimal-utils";
import { boardDayRange, PHASE1_BOARD_TIMEZONE } from "@/lib/board-date";
import { stateToTimeZone, zonedDateTimeToUtc } from "@/lib/timezone";
import { stageExitObligations, type ChecklistLoadInput } from "@/lib/ui/load-checklist";
import { withNonDeletedRegionScope, withRegionScope } from "@/lib/scoped-query";
import { createAuditLog } from "@/lib/audit";
import { computeLoadMetrics } from "@/server/kpi";
import { getEffectiveFscRate } from "@/server/fsc";
import { getRegionConfig } from "@/server/region-config";
import { workerOrchestratorAdapter } from "@/domain/workers/orchestrator-adapter";
import { getEnv } from "@/lib/env";

/** Statuses where a delivery can still be meaningfully rescheduled (in-flight, undelivered). */
const RESCHEDULABLE_STATUSES = new Set<string>(["BOOKED", "DISPATCHED", "PICKED_UP"]);
/** Terminal exception states a load can't be revived from via a status change. */
const TERMINAL_EXCEPTION_STATUSES = new Set<string>(["CANCELED", "FAILED"]);

/** Forward order of the lifecycle ladder (excludes the CANCELED/FAILED exception states). */
const LIFECYCLE_ORDER = ["BOOKED", "DISPATCHED", "PICKED_UP", "DELIVERED", "POD_RECEIVED", "COMPLETED"];

/** A board write rejected by a business rule (vs a not-found or a server fault) → HTTP 409. */
export class BoardRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardRuleError";
  }
}

/** Advancing past open SOFT obligations — recoverable with an override reason → HTTP 409 + needsOverrideReason. */
export class SoftGateError extends Error {
  readonly openItems: string[];
  constructor(openItems: string[]) {
    super(`Open items must be addressed or overridden with a reason: ${openItems.join(", ")}.`);
    this.name = "SoftGateError";
    this.openItems = openItems;
  }
}

interface DropLotBoardRow {
  id: string;
  name: string;
  code: string | null;
  note: string | null;
  city: string;
  state: string;
  sortOrder: number;
  dailyCapacity: number | null;
  slipSeat: boolean;
  dropHookRequired: boolean;
}

interface BoardLoadDbRow {
  id: string;
  rateConfirmationId: string | null;
  status: string;
  dropLotId: string | null;
  dropLot: { id: string; name: string } | null;
  threePlRefNumber: string | null;
  attentionNote: string | null;
  attentionSeverity: "INFO" | "WARN" | "URGENT";
  scaleBeforeTask: "NOT_DONE" | "DONE";
  scaleAfterTask: "NOT_DONE" | "DONE";
  bolMatchTask: "NOT_DONE" | "DONE";
  pickupEtaAdvised: "NOT_DONE" | "DONE";
  pickupArrivalAdvised: "NOT_DONE" | "DONE";
  deliveryEtaAdvised: "NOT_DONE" | "DONE";
  deliveryArrivalAdvised: "NOT_DONE" | "DONE";
  deliveryExceptionState: "NONE" | "WORK_IN_REQUESTED" | "RESCHEDULED";
  rescheduleDriverConfirmed: "NOT_DONE" | "DONE";
  routeId: string | null;
  loadNumber: string | null;
  pickupNumber: string | null;
  pickupNumbers: string[];
  broker: { name: string } | null;
  mgStatusTask: "NOT_DONE" | "DONE";
  tmwStatusTask: "NOT_DONE" | "DONE";
  pickupDriverAssigned: string | null;
  deliveryDriver: string | null;
  tractorTrailer1: string | null;
  tractorTrailer2: string | null;
  shipperName: string | null;
  commodity: string | null;
  equipmentNeeds: string | null;
  equipmentType: string | null;
  equipmentAccessory: string | null;
  equipmentOtherText: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupWindow: string | null;
  puStatusPreset: string;
  puStatusCustom: string | null;
  receiverName: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryDate: Date | null;
  deliveryWindow: string | null;
  deliveryApptType: string | null;
  deliveryWindowStart: Date | null;
  deliveryWindowEnd: Date | null;
  delStatusPreset: string;
  delStatusCustom: string | null;
  podStatus: string | null;
  lineHaulRate: Prisma.Decimal;
  fscAmount: Prisma.Decimal;
  tonuAmount: Prisma.Decimal;
  allInRevenue: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
  totalTripMiles: Prisma.Decimal | null;
  negotiableMiles: Prisma.Decimal | null;
  loadedRpm: Prisma.Decimal | null;
  coordinatorNotes: string | null;
  driverType: string | null;
  legs: Array<{
    id: string;
    legIndex: number;
    legType: string;
    driverName: string | null;
    startCity: string | null;
    startState: string | null;
    endCity: string | null;
    endState: string | null;
    legMiles: Prisma.Decimal | null;
    notes: string | null;
    etaAt: Date | null;
    arrivalAt: Date | null;
    trailer: string | null;
    trailerHookConfirmed: string;
  }>;
}

function cityState(city: string | null, state: string | null): string | null {
  if (!city && !state) {
    return null;
  }
  if (!city) {
    return state;
  }
  if (!state) {
    return city;
  }
  return `${city}, ${state}`;
}

function decimalOrZero(value: Prisma.Decimal | null | undefined): Prisma.Decimal {
  return value ?? new Prisma.Decimal(0);
}

function loadToBoardRow(load: {
  id: string;
  rateConfirmationId: string | null;
  status: string;
  dropLot: { name: string } | null;
  threePlRefNumber: string | null;
  attentionNote: string | null;
  attentionSeverity: "INFO" | "WARN" | "URGENT";
  scaleBeforeTask: "NOT_DONE" | "DONE";
  scaleAfterTask: "NOT_DONE" | "DONE";
  bolMatchTask: "NOT_DONE" | "DONE";
  pickupEtaAdvised: "NOT_DONE" | "DONE";
  pickupArrivalAdvised: "NOT_DONE" | "DONE";
  deliveryEtaAdvised: "NOT_DONE" | "DONE";
  deliveryArrivalAdvised: "NOT_DONE" | "DONE";
  deliveryExceptionState: "NONE" | "WORK_IN_REQUESTED" | "RESCHEDULED";
  rescheduleDriverConfirmed: "NOT_DONE" | "DONE";
  routeId: string | null;
  loadNumber: string | null;
  pickupNumber: string | null;
  pickupNumbers: string[];
  broker: { name: string } | null;
  mgStatusTask: "NOT_DONE" | "DONE";
  tmwStatusTask: "NOT_DONE" | "DONE";
  pickupDriverAssigned: string | null;
  deliveryDriver: string | null;
  tractorTrailer1: string | null;
  tractorTrailer2: string | null;
  shipperName: string | null;
  commodity: string | null;
  equipmentNeeds: string | null;
  equipmentType: string | null;
  equipmentAccessory: string | null;
  equipmentOtherText: string | null;
  pickupCity: string | null;
  pickupState: string | null;
  pickupWindow: string | null;
  puStatusPreset: string;
  puStatusCustom: string | null;
  receiverName: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryDate: Date | null;
  deliveryWindow: string | null;
  deliveryApptType: string | null;
  deliveryWindowStart: Date | null;
  deliveryWindowEnd: Date | null;
  delStatusPreset: string;
  delStatusCustom: string | null;
  podStatus: string | null;
  lineHaulRate: Prisma.Decimal;
  fscAmount: Prisma.Decimal;
  tonuAmount: Prisma.Decimal;
  allInRevenue: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
  totalTripMiles: Prisma.Decimal | null;
  negotiableMiles: Prisma.Decimal | null;
  loadedRpm: Prisma.Decimal | null;
  coordinatorNotes: string | null;
  driverType: string | null;
  legs: Array<{
    id: string;
    legIndex: number;
    legType: string;
    driverName: string | null;
    startCity: string | null;
    startState: string | null;
    endCity: string | null;
    endState: string | null;
    legMiles: Prisma.Decimal | null;
    notes: string | null;
    etaAt: Date | null;
    arrivalAt: Date | null;
    trailer: string | null;
    trailerHookConfirmed: string;
  }>;
}): BoardLoadRow {
  return {
    id: load.id,
    rateConfirmationId: load.rateConfirmationId,
    threePlRefNumber: load.threePlRefNumber,
    status: load.status,
    lateCancelFailedNote: load.attentionNote,
    attentionSeverity: load.attentionSeverity,
    scaleBeforeTask: load.scaleBeforeTask,
    scaleAfterTask: load.scaleAfterTask,
    bolMatchTask: load.bolMatchTask,
    pickupEtaAdvised: load.pickupEtaAdvised,
    pickupArrivalAdvised: load.pickupArrivalAdvised,
    deliveryEtaAdvised: load.deliveryEtaAdvised,
    deliveryArrivalAdvised: load.deliveryArrivalAdvised,
    deliveryExceptionState: load.deliveryExceptionState,
    rescheduleDriverConfirmed: load.rescheduleDriverConfirmed,
    routeId: load.routeId,
    loadNumber: load.loadNumber,
    pickupNumber: load.pickupNumber,
    pickupNumbers: load.pickupNumbers,
    brokerName: load.broker?.name ?? null,
    brokerRepName: null,
    mgStatusTask: load.mgStatusTask,
    tmwStatusTask: load.tmwStatusTask,
    pickupDriverAssigned: load.pickupDriverAssigned,
    deliveryDriver: load.deliveryDriver,
    tractorTrailer1: load.tractorTrailer1,
    tractorTrailer2: load.tractorTrailer2,
    shipperName: load.shipperName,
    commodity: load.commodity,
    equipmentNeeds: load.equipmentNeeds,
    equipmentType: load.equipmentType,
    equipmentAccessory: load.equipmentAccessory,
    equipmentOtherText: load.equipmentOtherText,
    pickupCityState: cityState(load.pickupCity, load.pickupState),
    pickupWindow: load.pickupWindow,
    puStatusPreset: load.puStatusPreset,
    puStatusCustom: load.puStatusCustom,
    receiverName: load.receiverName,
    deliveryCityState: cityState(load.deliveryCity, load.deliveryState),
    deliveryDate: load.deliveryDate?.toISOString() ?? null,
    deliveryWindow: load.deliveryWindow,
    deliveryApptType: load.deliveryApptType,
    deliveryWindowStartIso: load.deliveryWindowStart?.toISOString() ?? null,
    deliveryWindowEndIso: load.deliveryWindowEnd?.toISOString() ?? null,
    delStatusPreset: load.delStatusPreset,
    delStatusCustom: load.delStatusCustom,
    podStatus: load.podStatus,
    lineHaulRate: decimalOrZero(load.lineHaulRate).toString(),
    fscAmount: decimalOrZero(load.fscAmount).toString(),
    tonuAmount: decimalOrZero(load.tonuAmount).toString(),
    allInRevenue: decimalOrZero(load.allInRevenue).toString(),
    loadedMiles: decimalOrZero(load.loadedMiles).toString(),
    puDeadheadMiles: decimalOrZero(load.puDeadheadMiles).toString(),
    delDeadheadMiles: decimalOrZero(load.delDeadheadMiles).toString(),
    totalTripMiles: load.totalTripMiles?.toString() ?? null,
    negotiableMiles: load.negotiableMiles?.toString() ?? null,
    loadedRpm: load.loadedRpm?.toString() ?? null,
    nby: load.totalTripMiles
      ? (safeDivideDecimal(decimalOrZero(load.lineHaulRate), load.totalTripMiles)?.toString() ?? null)
      : null,
    emptyMilePct: load.totalTripMiles
      ? (safeDivideDecimal(
          decimalOrZero(load.puDeadheadMiles).plus(decimalOrZero(load.delDeadheadMiles)),
          load.totalTripMiles
        )?.toString() ?? null)
      : null,
    coordinatorNotes: load.coordinatorNotes,
    driverType: load.driverType,
    dropLotName: load.dropLot?.name ?? null,
    legs: (load.legs ?? []).map((leg) => ({
      id: leg.id,
      legIndex: leg.legIndex,
      legType: leg.legType,
      driverName: leg.driverName,
      startCity: leg.startCity,
      startState: leg.startState,
      endCity: leg.endCity,
      endState: leg.endState,
      legMiles: leg.legMiles?.toString() ?? null,
      notes: leg.notes,
      etaAtIso: leg.etaAt?.toISOString() ?? null,
      arrivalAtIso: leg.arrivalAt?.toISOString() ?? null,
      trailer: leg.trailer,
      trailerHookConfirmed: leg.trailerHookConfirmed
    }))
  };
}

const boardLoadSelect = {
  id: true,
  rateConfirmationId: true,
  status: true,
  dropLotId: true,
  threePlRefNumber: true,
  attentionNote: true,
  attentionSeverity: true,
  scaleBeforeTask: true,
  scaleAfterTask: true,
  bolMatchTask: true,
  pickupEtaAdvised: true,
  pickupArrivalAdvised: true,
  deliveryEtaAdvised: true,
  deliveryArrivalAdvised: true,
  deliveryExceptionState: true,
  rescheduleDriverConfirmed: true,
  routeId: true,
  loadNumber: true,
  pickupNumber: true,
  pickupNumbers: true,
  broker: { select: { name: true } },
  mgStatusTask: true,
  tmwStatusTask: true,
  pickupDriverAssigned: true,
  deliveryDriver: true,
  tractorTrailer1: true,
  tractorTrailer2: true,
  shipperName: true,
  commodity: true,
  equipmentNeeds: true,
  equipmentType: true,
  equipmentAccessory: true,
  equipmentOtherText: true,
  pickupCity: true,
  pickupState: true,
  pickupWindow: true,
  puStatusPreset: true,
  puStatusCustom: true,
  receiverName: true,
  deliveryCity: true,
  deliveryState: true,
  deliveryDate: true,
  deliveryWindow: true,
  deliveryApptType: true,
  deliveryWindowStart: true,
  deliveryWindowEnd: true,
  delStatusPreset: true,
  delStatusCustom: true,
  podStatus: true,
  lineHaulRate: true,
  fscAmount: true,
  tonuAmount: true,
  allInRevenue: true,
  loadedMiles: true,
  puDeadheadMiles: true,
  delDeadheadMiles: true,
  totalTripMiles: true,
  negotiableMiles: true,
  loadedRpm: true,
  coordinatorNotes: true,
  driverType: true,
  legs: {
    orderBy: { legIndex: "asc" as const },
    select: {
      id: true,
      legIndex: true,
      legType: true,
      driverName: true,
      startCity: true,
      startState: true,
      endCity: true,
      endState: true,
      legMiles: true,
      notes: true,
      etaAt: true,
      arrivalAt: true,
      trailer: true,
      trailerHookConfirmed: true
    }
  },
  dropLot: {
    select: {
      id: true,
      name: true
    }
  }
} as const;

export async function getBoardResponse(input: {
  regionId: string;
  date: string;
}): Promise<BoardResponse> {
  const { dayStart, dayEnd } = boardDayRange(input.date, PHASE1_BOARD_TIMEZONE);

  return runInRegionScope(input.regionId, async (tx) => {
    const [dropLots, loads, deliveryLoads] = await Promise.all([
      tx.dropLot.findMany({
        where: withNonDeletedRegionScope(input.regionId)
      }) as unknown as Promise<DropLotBoardRow[]>,
      tx.load.findMany({
        where: withNonDeletedRegionScope(input.regionId, {
          bookingDate: {
            gte: dayStart,
            lt: dayEnd
          }
        }),
        orderBy: [{ dropLotId: "asc" }, { bookingDate: "asc" }, { createdAt: "asc" }],
        select: boardLoadSelect
      }) as unknown as Promise<BoardLoadDbRow[]>,
      // Loads DELIVERING on the viewed day (regardless of when they were booked),
      // so a load booked 6/17 that delivers 6/18 appears on the 6/18 board too.
      // Reference view only — excluded from dayTotals to avoid double-counting.
      tx.load.findMany({
        where: withNonDeletedRegionScope(input.regionId, {
          deliveryDate: {
            gte: dayStart,
            lt: dayEnd
          },
          status: { notIn: [LoadStatus.CANCELED, LoadStatus.FAILED] }
        }),
        orderBy: [{ deliveryDate: "asc" }, { createdAt: "asc" }],
        select: boardLoadSelect
      }) as unknown as Promise<BoardLoadDbRow[]>
    ]);
    dropLots.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

    const canceledStatuses = new Set(["CANCELED", "FAILED"]);
    const canceledLoads = loads.filter((load) => canceledStatuses.has(load.status));
    const activeLoads = loads.filter((load) => !canceledStatuses.has(load.status));
    const loadsByDropLot = new Map<string, typeof activeLoads>();
    for (const load of activeLoads) {
      if (!load.dropLotId) {
        continue;
      }
      const existing = loadsByDropLot.get(load.dropLotId) ?? [];
      existing.push(load);
      loadsByDropLot.set(load.dropLotId, existing);
    }
    const ltlDropLot = dropLots.find((dropLot) => (dropLot.code ?? "").toUpperCase() === "LTL" || dropLot.name.toUpperCase() === "LTL");
    const adHocLoads = activeLoads.filter((load) => !load.dropLotId);
    if (ltlDropLot && adHocLoads.length > 0) {
      const existing = loadsByDropLot.get(ltlDropLot.id) ?? [];
      loadsByDropLot.set(ltlDropLot.id, [...existing, ...adHocLoads]);
    }

    const dropLotSections: BoardSection[] = dropLots.map((dropLot) => {
      const sectionLoads = loadsByDropLot.get(dropLot.id) ?? [];
      return {
        type: "drop_lot",
        title: dropLot.name,
        filledCount: sectionLoads.length,
        dropLot: {
          id: dropLot.id,
          name: dropLot.name,
          code: dropLot.code,
          note: dropLot.note,
          city: dropLot.city,
          state: dropLot.state,
          sortOrder: dropLot.sortOrder,
          dailyCapacity: dropLot.dailyCapacity,
          slipSeat: dropLot.slipSeat,
          dropHookRequired: dropLot.dropHookRequired
        },
        loads: sectionLoads.map(loadToBoardRow)
      };
    });

    const adHocSection: BoardSection | null = ltlDropLot
      ? null
      : {
          type: "adhoc",
          title: "LTL",
          code: "LTL",
          note: "Retail trucks without a fixed drop lot; typically deadhead to CDC unless backhaul is sourced.",
          filledCount: adHocLoads.length,
          dropLot: null,
          loads: adHocLoads.map(loadToBoardRow)
        };

    const canceledSection: BoardSection = {
      type: "canceled",
      title: "CANCELED / TONU",
      filledCount: canceledLoads.length,
      dropLot: null,
      loads: canceledLoads.map(loadToBoardRow)
    };

    const deliveriesSection: BoardSection = {
      type: "deliveries",
      title: `DELIVERIES DUE (${input.date})`,
      note: "Loads delivering today (booked on any day). Reference view — open a row to update its delivery status.",
      filledCount: deliveryLoads.length,
      dropLot: null,
      loads: deliveryLoads.map(loadToBoardRow)
    };

    const regionNextDaySection: BoardSection = {
      type: "region_next_day",
      title: "REGION (next-day prep)",
      filledCount: 0,
      dropLot: null,
      loads: []
    };

    const localAwleInboundSection: BoardSection = {
      type: "local_awle_inbound",
      title: "LOCAL CDC INBOUND",
      filledCount: 0,
      dropLot: null,
      loads: []
    };

    const lineHaulTotal = activeLoads.reduce((acc, load) => acc.plus(load.lineHaulRate), new Prisma.Decimal(0));
    const fscTotal = activeLoads.reduce((acc, load) => acc.plus(decimalOrZero(load.fscAmount)), new Prisma.Decimal(0));
    const tonuTotal = loads.reduce((acc, load) => acc.plus(decimalOrZero(load.tonuAmount)), new Prisma.Decimal(0));
    const allInTotal = activeLoads.reduce((acc, load) => acc.plus(decimalOrZero(load.allInRevenue)), new Prisma.Decimal(0));
    const loadedMilesTotal = activeLoads.reduce((acc, load) => acc.plus(load.loadedMiles), new Prisma.Decimal(0));
    const puDeadheadTotal = activeLoads.reduce((acc, load) => acc.plus(load.puDeadheadMiles), new Prisma.Decimal(0));
    const delDeadheadTotal = activeLoads.reduce((acc, load) => acc.plus(load.delDeadheadMiles), new Prisma.Decimal(0));
    const emptyMilesTotal = puDeadheadTotal.plus(delDeadheadTotal);
    const totalTripMiles = loadedMilesTotal.plus(emptyMilesTotal);
    const emptyMilePct = safeDivideDecimal(emptyMilesTotal, totalTripMiles);
    const nbyTotal = safeDivideDecimal(lineHaulTotal, totalTripMiles);
    const config = await getRegionConfig(input.regionId);

    return {
      regionId: input.regionId,
      date: input.date,
      sections: [
        ...dropLotSections,
        ...(adHocSection ? [adHocSection] : []),
        deliveriesSection,
        canceledSection,
        regionNextDaySection,
        localAwleInboundSection
      ],
      dayTotals: {
        loadCount: activeLoads.length,
        lineHaulTotal: lineHaulTotal.toString(),
        fscTotal: fscTotal.toString(),
        tonuTotal: tonuTotal.toString(),
        allInTotal: allInTotal.toString(),
        loadedMilesTotal: loadedMilesTotal.toString(),
        emptyMilePct: emptyMilePct?.toString() ?? null,
        nby: nbyTotal?.toString() ?? null
      },
      config
    };
  });
}

export async function moveBoardLoad(input: {
  regionId: string;
  loadId: string;
  targetSectionId: string;
  actorId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: { id: true, status: true, dropLotId: true, isTONU: true, tonuAmount: true }
    });
    if (!load) {
      throw new Error("Load not found.");
    }

    let nextDropLotId: string | null = load.dropLotId;
    let nextStatus = load.status;
    let nextIsTonu = load.isTONU;
    let nextTonuAmount = load.tonuAmount;

    if (input.targetSectionId === "adhoc" || input.targetSectionId.startsWith("adhoc-")) {
      const ltlDropLot = await tx.dropLot.findFirst({
        where: withRegionScope(input.regionId, {
          OR: [{ code: "LTL" }, { name: "LTL" }]
        }),
        select: { id: true }
      });
      nextDropLotId = ltlDropLot?.id ?? null;
      nextStatus = "BOOKED";
      nextIsTonu = false;
      nextTonuAmount = new Prisma.Decimal(0);
    } else if (input.targetSectionId === "canceled" || input.targetSectionId.startsWith("canceled-")) {
      nextDropLotId = null;
      nextStatus = "CANCELED";
      nextIsTonu = false;
      nextTonuAmount = new Prisma.Decimal(0);
    } else {
      const targetLot = await tx.dropLot.findFirst({
        where: withRegionScope(input.regionId, { id: input.targetSectionId }),
        select: { id: true }
      });
      if (!targetLot) {
        throw new Error("Target drop lot not found.");
      }
      nextDropLotId = targetLot.id;
      nextStatus = "BOOKED";
      nextIsTonu = false;
      nextTonuAmount = new Prisma.Decimal(0);
    }

    await tx.load.update({
      where: { id: load.id },
      data: {
        dropLotId: nextDropLotId,
        status: nextStatus as never,
        isTONU: nextIsTonu,
        tonuAmount: nextTonuAmount
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: "BOARD_MOVE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          targetSectionId: input.targetSectionId,
          status: nextStatus,
          dropLotId: nextDropLotId,
          isTONU: nextIsTonu
        }
      })
    });
  });
}

export async function setLoadTonuLifecycle(input: {
  regionId: string;
  loadId: string;
  isTonu: boolean;
  tonuAmount?: string | null;
  actorId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: { id: true }
    });
    if (!load) {
      throw new Error("Load not found.");
    }
    if (input.isTonu && (!input.tonuAmount || input.tonuAmount.trim().length === 0)) {
      throw new Error("TONU amount is required when marking TONU.");
    }
    const resolvedAmount = input.isTonu ? new Prisma.Decimal(input.tonuAmount ?? "0") : new Prisma.Decimal(0);
    await tx.load.update({
      where: { id: load.id },
      data: {
        isTONU: input.isTonu,
        tonuAmount: resolvedAmount,
        status: (input.isTonu ? "CANCELED" : "BOOKED") as never,
        allInRevenue: input.isTonu ? resolvedAmount : undefined
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: input.isTonu ? "TONU_MARKED" : "TONU_CLEARED",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          isTONU: input.isTonu,
          tonuAmount: resolvedAmount.toString()
        }
      })
    });
  });
}

export type LoadLifecycleStatus =
  | "BOOKED"
  | "DISPATCHED"
  | "PICKED_UP"
  | "DELIVERED"
  | "POD_RECEIVED"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED";

export async function setBoardLoadStatus(input: {
  regionId: string;
  loadId: string;
  status: LoadLifecycleStatus;
  actorId: string;
  /** Reason recorded when advancing past open SOFT obligations (accountability, not a bypass of hard gates). */
  overrideReason?: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: {
        id: true,
        status: true,
        isTONU: true,
        tonuAmount: true,
        // Checklist inputs for the lifecycle gate.
        mgStatusTask: true,
        tmwStatusTask: true,
        scaleBeforeTask: true,
        scaleAfterTask: true,
        bolMatchTask: true,
        pickupEtaAdvised: true,
        pickupArrivalAdvised: true,
        deliveryEtaAdvised: true,
        deliveryArrivalAdvised: true,
        podStatus: true,
        rateConfirmationId: true,
        pickupNumber: true,
        pickupNumbers: true,
        pickupDriverAssigned: true,
        deliveryDriver: true,
        legs: { select: { driverName: true } }
      }
    });
    if (!load) throw new Error("Load not found.");

    // Don't resurrect a cancelled/failed load — those are terminal exception states.
    // (Re-opening one should be a deliberate, separate action, not a status click.)
    if (TERMINAL_EXCEPTION_STATUSES.has(load.status) && load.status !== input.status) {
      throw new BoardRuleError(`Cannot change status of a ${load.status} load.`);
    }

    // Lifecycle checklist gate — only on a forward advance along the ladder.
    const fromIdx = LIFECYCLE_ORDER.indexOf(load.status);
    const toIdx = LIFECYCLE_ORDER.indexOf(input.status);
    let overriddenItems: string[] = [];
    if (fromIdx >= 0 && toIdx > fromIdx) {
      const checklistInput: ChecklistLoadInput = {
        status: load.status,
        mgStatusTask: load.mgStatusTask,
        tmwStatusTask: load.tmwStatusTask,
        scaleBeforeTask: load.scaleBeforeTask,
        scaleAfterTask: load.scaleAfterTask,
        bolMatchTask: load.bolMatchTask,
        pickupEtaAdvised: load.pickupEtaAdvised,
        pickupArrivalAdvised: load.pickupArrivalAdvised,
        deliveryEtaAdvised: load.deliveryEtaAdvised,
        deliveryArrivalAdvised: load.deliveryArrivalAdvised,
        podStatus: load.podStatus,
        rateConfirmationId: load.rateConfirmationId,
        pickupNumber: load.pickupNumber,
        pickupNumbers: load.pickupNumbers,
        pickupDriverAssigned: load.pickupDriverAssigned,
        deliveryDriver: load.deliveryDriver,
        legs: load.legs
      };
      const { hardOpen, softOpen } = stageExitObligations(checklistInput, load.status);
      if (hardOpen.length > 0) {
        throw new BoardRuleError(`Cannot advance to ${input.status}: ${hardOpen.map((i) => i.label).join(", ")} required first.`);
      }
      if (softOpen.length > 0 && !input.overrideReason) {
        throw new SoftGateError(softOpen.map((i) => i.label));
      }
      if (softOpen.length > 0) {
        overriddenItems = softOpen.map((i) => i.label);
      }
    }

    await tx.load.update({
      where: { id: load.id },
      data: {
        status: input.status as never,
        isTONU: input.status === "CANCELED" ? load.isTONU : false,
        tonuAmount: input.status === "CANCELED" ? load.tonuAmount : new Prisma.Decimal(0),
        allInRevenue:
          input.status === "CANCELED" || !load.isTONU
            ? undefined
            : new Prisma.Decimal(0)
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: overriddenItems.length > 0 ? "BOARD_STATUS_OVERRIDE" : "BOARD_STATUS_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: overriddenItems.length > 0 ? input.overrideReason : undefined,
        afterValue: overriddenItems.length > 0 ? { status: input.status, skipped: overriddenItems } : { status: input.status }
      })
    });
  });
}

export async function updateBoardLoadFields(input: {
  regionId: string;
  loadId: string;
  actorId: string;
  fields: Partial<{
    mgStatusTask: "NOT_DONE" | "DONE";
    tmwStatusTask: "NOT_DONE" | "DONE";
    scaleBeforeTask: "NOT_DONE" | "DONE";
    scaleAfterTask: "NOT_DONE" | "DONE";
    bolMatchTask: "NOT_DONE" | "DONE";
    pickupEtaAdvised: "NOT_DONE" | "DONE";
    pickupArrivalAdvised: "NOT_DONE" | "DONE";
    deliveryEtaAdvised: "NOT_DONE" | "DONE";
    deliveryArrivalAdvised: "NOT_DONE" | "DONE";
    deliveryExceptionState: "NONE" | "WORK_IN_REQUESTED" | "RESCHEDULED";
    rescheduleDriverConfirmed: "NOT_DONE" | "DONE";
    puStatusPreset: "ETA_TO_PU_DEL" | "LOADED_SET_TO_DEL" | "LATE" | "DONE" | "OTHER";
    puStatusCustom: string | null;
    delStatusPreset: "ETA_TO_PU_DEL" | "LOADED_SET_TO_DEL" | "LATE" | "DONE" | "OTHER";
    delStatusCustom: string | null;
    deliveryDate: string | null;
    pickupDriverAssigned: string | null;
    deliveryDriver: string | null;
    commodity: string | null;
    equipmentNeeds: string | null;
    driverType: "SHUTTLE" | "PTP" | "LTL" | null;
    coordinatorNotes: string | null;
    attentionNote: string | null;
    attentionSeverity: "INFO" | "WARN" | "URGENT";
    podStatus: string | null;
    // Descriptive / operational fields (direct set).
    shipperName: string | null;
    receiverName: string | null;
    pickupCity: string | null;
    pickupState: string | null;
    pickupWindow: string | null;
    deliveryCity: string | null;
    deliveryState: string | null;
    deliveryWindow: string | null;
    loadNumber: string | null;
    pickupNumber: string | null;
    pickupNumbers: string[];
    threePlRefNumber: string | null;
    tractorTrailer1: string | null;
    tractorTrailer2: string | null;
    equipmentType: "BOX_TRUCK" | "FLATBED_OR_STEPDECK" | "VAN_48" | "VAN_53" | "OTHER" | null;
    equipmentAccessory: "STRAPS" | "TARPS" | "CHAINS" | "BARS" | "NONE" | "OTHER" | null;
    equipmentOtherText: string | null;
    brokerId: string | null;
    lumperFeeAmount: string | null;
    // Financial inputs (string decimals) — changing any triggers a metrics
    // recompute and a week-snapshot recompute job.
    lineHaulRate: string;
    loadedMiles: string;
    puDeadheadMiles: string;
    delDeadheadMiles: string;
    fscApplies: boolean;
  }>;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: {
        id: true,
        weekIso: true,
        isTONU: true,
        tonuAmount: true,
        lineHaulRate: true,
        loadedMiles: true,
        puDeadheadMiles: true,
        delDeadheadMiles: true,
        fscApplies: true
      }
    });
    if (!load) throw new Error("Load not found.");

    // Pull out fields needing conversion/validation or that drive a recompute;
    // the remaining fields pass through unchanged.
    const {
      deliveryDate,
      lumperFeeAmount,
      pickupNumbers,
      brokerId,
      lineHaulRate,
      loadedMiles,
      puDeadheadMiles,
      delDeadheadMiles,
      fscApplies,
      ...restFields
    } = input.fields;
    const updateData: Record<string, unknown> = { ...restFields };

    if (deliveryDate !== undefined) {
      // YYYY-MM-DD → Date at noon UTC to avoid timezone day-shift.
      updateData.deliveryDate = deliveryDate ? new Date(`${deliveryDate}T12:00:00.000Z`) : null;
    }
    if (lumperFeeAmount !== undefined) {
      updateData.lumperFeeAmount = lumperFeeAmount ? new Prisma.Decimal(lumperFeeAmount) : null;
    }
    if (pickupNumbers !== undefined) {
      updateData.pickupNumbers = pickupNumbers;
    }
    if (brokerId !== undefined) {
      if (brokerId) {
        const broker = await tx.broker.findFirst({
          where: withNonDeletedRegionScope(input.regionId, { id: brokerId }),
          select: { id: true }
        });
        if (!broker) throw new Error("Broker not found for region.");
      }
      updateData.brokerId = brokerId;
    }

    // Financial recompute: when any pricing/mileage input changes, recompute the
    // derived metrics server-side (Decimal math stays in the domain) and re-trigger
    // the week-snapshot recompute job.
    const financialChanged =
      lineHaulRate !== undefined ||
      loadedMiles !== undefined ||
      puDeadheadMiles !== undefined ||
      delDeadheadMiles !== undefined ||
      fscApplies !== undefined;
    if (financialChanged) {
      const nextLineHaul = lineHaulRate !== undefined ? new Prisma.Decimal(lineHaulRate) : load.lineHaulRate;
      const nextLoadedMiles = loadedMiles !== undefined ? new Prisma.Decimal(loadedMiles) : load.loadedMiles;
      const nextPuDh = puDeadheadMiles !== undefined ? new Prisma.Decimal(puDeadheadMiles) : load.puDeadheadMiles;
      const nextDelDh = delDeadheadMiles !== undefined ? new Prisma.Decimal(delDeadheadMiles) : load.delDeadheadMiles;
      const nextFscApplies = fscApplies !== undefined ? fscApplies : load.fscApplies;
      const fscRate = nextFscApplies ? await getEffectiveFscRate(input.regionId, load.weekIso, tx) : null;
      const metrics = computeLoadMetrics({
        lineHaulRate: nextLineHaul,
        loadedMiles: nextLoadedMiles,
        puDeadheadMiles: nextPuDh,
        delDeadheadMiles: nextDelDh,
        fscApplies: nextFscApplies,
        fscRateUsed: fscRate
      });
      updateData.lineHaulRate = nextLineHaul;
      updateData.loadedMiles = nextLoadedMiles;
      updateData.puDeadheadMiles = nextPuDh;
      updateData.delDeadheadMiles = nextDelDh;
      updateData.fscApplies = nextFscApplies;
      updateData.fscRateUsed = fscRate;
      updateData.fscAmount = metrics.fscAmount;
      updateData.totalTripMiles = metrics.totalTripMiles;
      updateData.negotiableMiles = metrics.negotiableMiles;
      updateData.loadedRpm = metrics.loadedRpm;
      updateData.emptyMilePct = metrics.emptyMilePct;
      // TONU loads keep their TONU all-in; otherwise use the recomputed all-in.
      updateData.allInRevenue = load.isTONU ? load.tonuAmount : metrics.allInRevenue;
    }

    await tx.load.update({
      where: { id: load.id },
      data: updateData as never
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: "BOARD_FIELD_UPDATE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.fields
      })
    });

    if (financialChanged) {
      const { SQS_RECOMPUTE_QUEUE_URL } = getEnv();
      await workerOrchestratorAdapter.enqueue(SQS_RECOMPUTE_QUEUE_URL, {
        regionId: input.regionId,
        weekIso: load.weekIso,
        entityId: load.id,
        eventType: "RECOMPUTE_WEEK_SNAPSHOT"
      });
    }
  });
}

export async function softDeleteBoardLoad(input: {
  regionId: string;
  loadId: string;
  reason: string;
  actorId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: { id: true }
    });
    if (!load) throw new Error("Load not found.");

    await tx.load.update({
      where: { id: load.id },
      data: { deletedAt: new Date() }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: "BOARD_SOFT_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason
      })
    });
  });
}

export async function upsertBoardLoadLeg(input: {
  regionId: string;
  loadId: string;
  actorId: string;
  leg: {
    id?: string;
    legIndex: number;
    legType: "SHUTTLE" | "PTP" | "DELIVERY";
    driverName?: string | null;
    startCity?: string | null;
    startState?: string | null;
    endCity?: string | null;
    endState?: string | null;
    legMiles?: string | null;
    notes?: string | null;
    etaAt?: string | null;
    arrivalAt?: string | null;
    trailer?: string | null;
    trailerHookConfirmed?: "NOT_DONE" | "DONE";
  };
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: { id: true }
    });
    if (!load) throw new Error("Load not found.");

    if (input.leg.id) {
      await tx.loadLeg.update({
        where: { id: input.leg.id },
        data: {
          legIndex: input.leg.legIndex,
          legType: input.leg.legType,
          driverName: input.leg.driverName ?? null,
          startCity: input.leg.startCity ?? null,
          startState: input.leg.startState ?? null,
          endCity: input.leg.endCity ?? null,
          endState: input.leg.endState ?? null,
          legMiles: input.leg.legMiles ? new Prisma.Decimal(input.leg.legMiles) : null,
          notes: input.leg.notes ?? null,
          etaAt: input.leg.etaAt ? new Date(input.leg.etaAt) : null,
          arrivalAt: input.leg.arrivalAt ? new Date(input.leg.arrivalAt) : null,
          trailer: input.leg.trailer ?? null,
          trailerHookConfirmed: input.leg.trailerHookConfirmed ?? "NOT_DONE"
        }
      });
    } else {
      await tx.loadLeg.create({
        data: {
          loadId: load.id,
          legIndex: input.leg.legIndex,
          legType: input.leg.legType as never,
          driverName: input.leg.driverName ?? null,
          startCity: input.leg.startCity ?? null,
          startState: input.leg.startState ?? null,
          endCity: input.leg.endCity ?? null,
          endState: input.leg.endState ?? null,
          legMiles: input.leg.legMiles ? new Prisma.Decimal(input.leg.legMiles) : null,
          notes: input.leg.notes ?? null,
          etaAt: input.leg.etaAt ? new Date(input.leg.etaAt) : null,
          arrivalAt: input.leg.arrivalAt ? new Date(input.leg.arrivalAt) : null,
          trailer: input.leg.trailer ?? null,
          trailerHookConfirmed: input.leg.trailerHookConfirmed ?? "NOT_DONE"
        }
      });
    }
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: "BOARD_LEG_UPSERT",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: input.leg
      })
    });
  });
}

/**
 * Reschedule a load's delivery appointment to a new structured window after a
 * missed appt. Re-entered as a local date + HH:MM window (localised to the
 * destination stop's timezone), this OVERWRITES the delivery appt fields so the
 * firm-appt engine self-corrects (APPT_MISSED clears, APPT_APPROACHING re-arms),
 * marks the load RESCHEDULED, and resets the next-day-driver obligation.
 */
export async function rescheduleBoardLoadDelivery(input: {
  regionId: string;
  loadId: string;
  actorId: string;
  date: string; // YYYY-MM-DD (local to the delivery stop)
  windowStart: string; // HH:MM
  windowEnd: string; // HH:MM
  apptType: "FIRM_APPT" | "OPEN_WINDOW" | "FCFS";
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const load = await tx.load.findFirst({
      where: withNonDeletedRegionScope(input.regionId, { id: input.loadId }),
      select: { id: true, deliveryState: true, status: true }
    });
    if (!load) throw new Error("Load not found.");

    // Only in-flight, undelivered loads can be rescheduled — a delivered/terminal
    // load has nothing left to reschedule.
    if (!RESCHEDULABLE_STATUSES.has(load.status)) {
      throw new BoardRuleError(`Cannot reschedule a ${load.status} load.`);
    }

    if (input.windowEnd <= input.windowStart) {
      throw new BoardRuleError("windowEnd must be after windowStart.");
    }
    const tz = stateToTimeZone(load.deliveryState);
    const windowStart = zonedDateTimeToUtc(input.date, input.windowStart, tz);
    const windowEnd = zonedDateTimeToUtc(input.date, input.windowEnd, tz);
    if (!windowStart || !windowEnd) {
      throw new Error("Invalid reschedule window.");
    }

    await tx.load.update({
      where: { id: load.id },
      data: {
        deliveryDate: new Date(`${input.date}T12:00:00.000Z`),
        deliveryApptType: input.apptType as never,
        deliveryWindowStart: windowStart,
        deliveryWindowEnd: windowEnd,
        deliveryTimeZone: tz,
        deliveryExceptionState: "RESCHEDULED",
        rescheduleDriverConfirmed: "NOT_DONE"
      }
    });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: load.id,
        action: "BOARD_DELIVERY_RESCHEDULE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          ...input,
          windowStartIso: windowStart.toISOString(),
          windowEndIso: windowEnd.toISOString(),
          timeZone: tz
        }
      })
    });
  });
}

export async function deleteBoardLoadLeg(input: {
  regionId: string;
  loadId: string;
  legId: string;
  actorId: string;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    const leg = await tx.loadLeg.findFirst({
      where: {
        id: input.legId,
        loadId: input.loadId,
        load: { regionId: input.regionId, deletedAt: null }
      },
      select: { id: true, loadId: true }
    });
    if (!leg) throw new Error("Load leg not found.");
    await tx.loadLeg.delete({ where: { id: leg.id } });
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "Load",
        entityId: leg.loadId,
        action: "BOARD_LEG_DELETE",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: { legId: leg.id }
      })
    });
  });
}
