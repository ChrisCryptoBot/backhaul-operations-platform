/**
 * Daily board response contract for the interactive load board.
 */
export interface BoardResponse {
  regionId: string;
  regionCode?: string | null;
  regionLabel?: string | null;
  availableRegions?: Array<{ id: string; code: string; name: string }>;
  activeRegionId?: string | null;
  date: string;
  sections: BoardSection[];
  dayTotals: BoardDayTotals;
  /** Per-region board tunables (Empty% color thresholds, whole percents). */
  config: BoardConfig;
}

export interface BoardConfig {
  emptyPctAmber: number;
  emptyPctRed: number;
  /** Aggregate weekly empty-mile % that fires the KPI dashboard alert. */
  emptyPctAlert: number;
}

export interface BoardDayTotals {
  loadCount: number;
  lineHaulTotal: string;
  fscTotal: string;
  tonuTotal: string;
  allInTotal: string;
  loadedMilesTotal: string;
  emptyMilePct: string | null;
  nby: string | null;
}

export interface BoardSection {
  type: "drop_lot" | "adhoc" | "canceled" | "region_next_day" | "local_awle_inbound" | "deliveries";
  title: string;
  code?: string | null;
  note?: string | null;
  filledCount: number;
  dropLot: BoardDropLotMeta | null;
  loads: BoardLoadRow[];
}

export interface BoardDropLotMeta {
  id: string;
  name: string;
  code?: string | null;
  note?: string | null;
  city: string;
  state: string;
  sortOrder: number;
  dailyCapacity: number | null;
  slipSeat: boolean;
  dropHookRequired: boolean;
}

export interface BoardLoadLegRow {
  id: string;
  legIndex: number;
  legType: string;
  driverName: string | null;
  startCity: string | null;
  startState: string | null;
  endCity: string | null;
  endState: string | null;
  legMiles: string | null;
  notes: string | null;
  etaAtIso: string | null;
  arrivalAtIso: string | null;
  trailer: string | null;
  trailerHookConfirmed: string;
}

export interface BoardLoadRow {
  id: string;
  rateConfirmationId: string | null;
  threePlRefNumber: string | null;
  status: string;
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
  routeId: string | null;
  loadNumber: string | null;
  pickupNumber: string | null;
  pickupNumbers: string[];
  brokerName: string | null;
  brokerRepName: string | null;
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
  pickupCityState: string | null;
  pickupWindow: string | null;
  puStatusPreset: string;
  puStatusCustom: string | null;
  receiverName: string | null;
  deliveryCityState: string | null;
  deliveryDate: string | null;
  deliveryWindow: string | null;
  deliveryApptType: string | null;
  deliveryWindowStartIso: string | null;
  deliveryWindowEndIso: string | null;
  delStatusPreset: string;
  delStatusCustom: string | null;
  podStatus: string | null;
  lineHaulRate: string;
  fscAmount: string;
  tonuAmount: string;
  allInRevenue: string;
  loadedMiles: string;
  puDeadheadMiles: string;
  delDeadheadMiles: string;
  totalTripMiles: string | null;
  negotiableMiles: string | null;
  loadedRpm: string | null;
  nby: string | null;
  emptyMilePct: string | null;
  coordinatorNotes: string | null;
  driverType: string | null;
  dropLotName: string | null;
  legs: BoardLoadLegRow[];
}
