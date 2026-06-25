export interface BoardColumnSpec {
  displayLabel: string;
  key: string;
}

/**
 * Full spreadsheet order preserved for roadmap parity.
 * MVP API/UI currently renders a scoped subset from this list.
 */
export const boardColumnSpecs: BoardColumnSpec[] = [
  { displayLabel: "DROP LOTS", key: "dropLots" },
  { displayLabel: "(3PL) REF #", key: "ref3pl" },
  { displayLabel: "PU/DEL STATUS", key: "pickupDeliveryStatus" },
  { displayLabel: "LATE (PU/DEL)/CANCELLATION/FAILED", key: "lateCancellationFailed" },
  { displayLabel: "TRACTOR WEIGHT (CONFIRMATION)", key: "tractorWeightConfirmation" },
  { displayLabel: "ROUTE ID #", key: "routeId" },
  { displayLabel: "LD #", key: "loadId" },
  { displayLabel: "PICK UP #", key: "pickupNumber" },
  { displayLabel: "CUSTOMER/BROKER & REP NAME", key: "customerBrokerRepName" },
  { displayLabel: "EVENT CODE", key: "eventCode" },
  { displayLabel: "MG STATUS", key: "mgStatus" },
  { displayLabel: "TMW STATUS", key: "tmwStatus" },
  { displayLabel: "01/PU DRIVER ASSIGNED IN TMW", key: "pickupDriverAssignedInTmw" },
  { displayLabel: "TRK/TRLR #'S", key: "tractorTrailer1" },
  { displayLabel: "COMMODITY", key: "commodity" },
  { displayLabel: "EQUIP. NEEDS", key: "equipmentNeeds" },
  { displayLabel: "LUMPER FEE (AMT)", key: "lumperFeeAmount" },
  { displayLabel: "SHIPPER NAME", key: "shipperName" },
  { displayLabel: "PICK UP: CITY, STATE", key: "pickupCityState" },
  { displayLabel: "PU WINDOW", key: "pickupWindow" },
  { displayLabel: "02/DEL DRIVER", key: "deliveryDriver" },
  { displayLabel: "TRK/TRLR2", key: "tractorTrailer2" },
  { displayLabel: "RECIEVER NAME", key: "receiverName" },
  { displayLabel: "DEL: CITY, STATE", key: "deliveryCityState" },
  { displayLabel: "DEL. DATE/ WINDOW", key: "deliveryDateWindow" },
  { displayLabel: "POD", key: "proofOfDelivery" },
  { displayLabel: "LINE HAUL RATE", key: "lineHaulRate" },
  { displayLabel: "LOADED (BILLABLE) MILES", key: "loadedBillableMiles" },
  { displayLabel: "PU DEADHEAD", key: "pickupDeadheadMiles" },
  { displayLabel: "DEL DEADHEAD", key: "deliveryDeadheadMiles" },
  { displayLabel: "TOTAL MILES = PU DH + LOADED MLS + DEL DH", key: "totalMiles" },
  { displayLabel: "TOTAL (NEGOTIABLE) MILES = LOADED MLS + PU DH", key: "negotiableMiles" },
  { displayLabel: "LOADED RPM", key: "loadedRpm" }
];

/**
 * MVP board slice: exactly the columns currently rendered in the read-only table.
 */
export const boardMvpColumnKeys = [
  "ref3pl",
  "pickupDeliveryStatus",
  "shipperName",
  "receiverName",
  "lineHaulRate",
  "loadedBillableMiles"
] as const;
