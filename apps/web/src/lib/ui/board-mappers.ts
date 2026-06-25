import type { BoardLoadRow, BoardResponse, BoardSection } from "@/lib/board-types";
import { toNumber } from "@/lib/ui/parse";

export interface ViewBoardLoadRow {
  id: string;
  rateConfirmationId: string | null;
  ref: string;
  status: string;
  shipper: string;
  receiver: string;
  lineHaul: number | null;
  loadedMi: number | null;
  puDh: number | null;
  delDh: number | null;
  totalMi: number | null;
  negMi: number | null;
  loadedRpm: number | null;
  nby: number | null;
  emptyPct: number | null;
  routeId: string | null;
  loadNumber: string | null;
  pickupNumber: string | null;
  pickupNumbers: string[];
  lateCancelFailedNote: string | null;
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
  brokerName: string | null;
  brokerRepName: string | null;
  mgStatusTask: "NOT_DONE" | "DONE";
  tmwStatusTask: "NOT_DONE" | "DONE";
  pickupDriverAssigned: string | null;
  deliveryDriver: string | null;
  tractorTrailer1: string | null;
  tractorTrailer2: string | null;
  commodity: string | null;
  equipmentNeeds: string | null;
  equipmentType: string | null;
  equipmentAccessory: string | null;
  equipmentOtherText: string | null;
  puStatusPreset: string;
  puStatusCustom: string | null;
  deliveryDate: string | null;
  deliveryApptType: string | null;
  deliveryWindowStartIso: string | null;
  deliveryWindowEndIso: string | null;
  delStatusPreset: string;
  delStatusCustom: string | null;
  podStatus: string | null;
  fscAmount: number | null;
  tonuAmount: number | null;
  allInRevenue: number | null;
  coordinatorNotes: string | null;
  driverType: string | null;
  pickupCityState: string | null;
  pickupWindow: string | null;
  deliveryCityState: string | null;
  deliveryWindow: string | null;
  dropLotName: string | null;
  legs: Array<{
    id: string;
    legIndex: number;
    legType: string;
    driverName: string | null;
    startCity: string | null;
    startState: string | null;
    endCity: string | null;
    endState: string | null;
    legMiles: number | null;
    notes: string | null;
    etaAtIso: string | null;
    arrivalAtIso: string | null;
    trailer: string | null;
    trailerHookConfirmed: string;
  }>;
}

export interface ViewBoardSection {
  id: string;
  type: BoardSection["type"];
  title: string;
  code: string | null;
  note: string | null;
  filledCount: number;
  capacity: number | null;
  city: string | null;
  state: string | null;
  slipSeat: boolean;
  dropHookRequired: boolean;
  loads: ViewBoardLoadRow[];
}

export interface ViewBoardResponse {
  regionId: string;
  regionCode: string | null;
  regionLabel: string | null;
  date: string;
  sections: ViewBoardSection[];
  totals: {
    loads: number;
    lineHaul: number | null;
    fsc: number | null;
    tonu: number | null;
    allIn: number | null;
    loadedMiles: number | null;
    emptyPctRatio: number | null;
    nby: number | null;
  };
  config: { emptyPctAmber: number; emptyPctRed: number; emptyPctAlert: number };
  availableRegions: Array<{ id: string; code: string; name: string }>;
  activeRegionId: string | null;
}

export function mapBoardRowToView(row: BoardLoadRow): ViewBoardLoadRow {
  return {
    id: row.id,
    rateConfirmationId: row.rateConfirmationId,
    ref: row.threePlRefNumber ?? "—",
    status: row.status,
    shipper: row.shipperName ?? "—",
    receiver: row.receiverName ?? "—",
    lineHaul: toNumber(row.lineHaulRate),
    loadedMi: toNumber(row.loadedMiles),
    puDh: toNumber(row.puDeadheadMiles),
    delDh: toNumber(row.delDeadheadMiles),
    totalMi: toNumber(row.totalTripMiles),
    negMi: toNumber(row.negotiableMiles),
    loadedRpm: toNumber(row.loadedRpm),
    nby: toNumber(row.nby),
    emptyPct: toNumber(row.emptyMilePct),
    routeId: row.routeId,
    loadNumber: row.loadNumber,
    pickupNumber: row.pickupNumber,
    pickupNumbers: row.pickupNumbers,
    lateCancelFailedNote: row.lateCancelFailedNote,
    attentionSeverity: row.attentionSeverity,
    scaleBeforeTask: row.scaleBeforeTask,
    scaleAfterTask: row.scaleAfterTask,
    bolMatchTask: row.bolMatchTask,
    pickupEtaAdvised: row.pickupEtaAdvised,
    pickupArrivalAdvised: row.pickupArrivalAdvised,
    deliveryEtaAdvised: row.deliveryEtaAdvised,
    deliveryArrivalAdvised: row.deliveryArrivalAdvised,
    deliveryExceptionState: row.deliveryExceptionState,
    rescheduleDriverConfirmed: row.rescheduleDriverConfirmed,
    brokerName: row.brokerName,
    brokerRepName: row.brokerRepName,
    mgStatusTask: row.mgStatusTask,
    tmwStatusTask: row.tmwStatusTask,
    pickupDriverAssigned: row.pickupDriverAssigned,
    deliveryDriver: row.deliveryDriver,
    tractorTrailer1: row.tractorTrailer1,
    tractorTrailer2: row.tractorTrailer2,
    commodity: row.commodity,
    equipmentNeeds: row.equipmentNeeds,
    equipmentType: row.equipmentType,
    equipmentAccessory: row.equipmentAccessory,
    equipmentOtherText: row.equipmentOtherText,
    puStatusPreset: row.puStatusPreset,
    puStatusCustom: row.puStatusCustom,
    deliveryDate: row.deliveryDate,
    deliveryApptType: row.deliveryApptType,
    deliveryWindowStartIso: row.deliveryWindowStartIso,
    deliveryWindowEndIso: row.deliveryWindowEndIso,
    delStatusPreset: row.delStatusPreset,
    delStatusCustom: row.delStatusCustom,
    podStatus: row.podStatus,
    fscAmount: toNumber(row.fscAmount),
    tonuAmount: toNumber(row.tonuAmount),
    allInRevenue: toNumber(row.allInRevenue),
    coordinatorNotes: row.coordinatorNotes,
    driverType: row.driverType,
    pickupCityState: row.pickupCityState,
    pickupWindow: row.pickupWindow,
    deliveryCityState: row.deliveryCityState,
    deliveryWindow: row.deliveryWindow,
    dropLotName: row.dropLotName,
    legs: (row.legs ?? []).map((leg) => ({
      id: leg.id,
      legIndex: leg.legIndex,
      legType: leg.legType,
      driverName: leg.driverName,
      startCity: leg.startCity,
      startState: leg.startState,
      endCity: leg.endCity,
      endState: leg.endState,
      legMiles: toNumber(leg.legMiles),
      trailer: leg.trailer,
      trailerHookConfirmed: leg.trailerHookConfirmed,
      notes: leg.notes,
      etaAtIso: leg.etaAtIso,
      arrivalAtIso: leg.arrivalAtIso
    }))
  };
}

function sectionIdFrom(section: BoardSection, index: number): string {
  if (section.dropLot?.id) {
    return section.dropLot.id;
  }
  return `${section.type}-${index}`;
}

export function mapBoardResponseToView(response: BoardResponse): ViewBoardResponse {
  return {
    regionId: response.regionId,
    regionCode: response.regionCode ?? null,
    regionLabel: response.regionLabel ?? null,
    date: response.date,
    sections: response.sections.map((section, index) => ({
      id: sectionIdFrom(section, index),
      type: section.type,
      title: section.title,
      code: section.code ?? section.dropLot?.code ?? null,
      note: section.note ?? section.dropLot?.note ?? null,
      filledCount: section.filledCount,
      capacity: section.dropLot?.dailyCapacity ?? null,
      city: section.dropLot?.city ?? null,
      state: section.dropLot?.state ?? null,
      slipSeat: section.dropLot?.slipSeat ?? false,
      dropHookRequired: section.dropLot?.dropHookRequired ?? false,
      loads: section.loads.map(mapBoardRowToView)
    })),
    totals: {
      loads: response.dayTotals.loadCount,
      lineHaul: toNumber(response.dayTotals.lineHaulTotal),
      fsc: toNumber(response.dayTotals.fscTotal),
      tonu: toNumber(response.dayTotals.tonuTotal),
      allIn: toNumber(response.dayTotals.allInTotal),
      loadedMiles: toNumber(response.dayTotals.loadedMilesTotal),
      emptyPctRatio: toNumber(response.dayTotals.emptyMilePct),
      nby: toNumber(response.dayTotals.nby)
    },
    config: response.config ?? { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
    availableRegions: response.availableRegions ?? [],
    activeRegionId: response.activeRegionId ?? null
  };
}
