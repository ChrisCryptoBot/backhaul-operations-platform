import { describe, expect, test } from "vitest";
import type { ViewBoardLoadRow } from "@/lib/ui/board-mappers";
import { deriveLoadAlerts, type LoadAlertContext } from "@/lib/ui/load-alerts";
import { deriveLoadChecklist } from "@/lib/ui/load-checklist";

// Guards against drift between the rail's alert engine and the checklist registry.
// Both are hand-maintained; for the shared obligation keys their done-predicates
// must agree: if an obligation alert fires, the checklist shows that item open;
// when the flag is DONE, the alert is gone and the checklist item is done.

const CTX: LoadAlertContext = { emptyPctAmber: 15, emptyPctRed: 25 };

function makeRow(o: Partial<ViewBoardLoadRow> = {}): ViewBoardLoadRow {
  return {
    id: "load-1",
    rateConfirmationId: "rc-1",
    ref: "3P-1",
    status: "DISPATCHED",
    shipper: "S",
    receiver: "R",
    lineHaul: 1000,
    loadedMi: 500,
    puDh: 10,
    delDh: 10,
    totalMi: 520,
    negMi: 500,
    loadedRpm: 2,
    nby: 2,
    emptyPct: 0.05,
    routeId: "RT-1",
    loadNumber: "L1",
    pickupNumber: "PU-1",
    pickupNumbers: [],
    lateCancelFailedNote: null,
    attentionSeverity: "INFO",
    scaleBeforeTask: "DONE",
    scaleAfterTask: "DONE",
    bolMatchTask: "DONE",
    pickupEtaAdvised: "DONE",
    pickupArrivalAdvised: "DONE",
    deliveryEtaAdvised: "DONE",
    deliveryArrivalAdvised: "DONE",
    deliveryExceptionState: "NONE",
    rescheduleDriverConfirmed: "DONE",
    brokerName: "Broker",
    brokerRepName: null,
    mgStatusTask: "DONE",
    tmwStatusTask: "DONE",
    pickupDriverAssigned: "J. Doe",
    deliveryDriver: null,
    tractorTrailer1: null,
    tractorTrailer2: null,
    commodity: null,
    equipmentNeeds: null,
    equipmentType: null,
    equipmentAccessory: null,
    equipmentOtherText: null,
    puStatusPreset: "OTHER",
    puStatusCustom: null,
    deliveryDate: null,
    deliveryApptType: null,
    deliveryWindowStartIso: null,
    deliveryWindowEndIso: null,
    delStatusPreset: "OTHER",
    delStatusCustom: null,
    podStatus: "SENT_TO_BROKER",
    fscAmount: 0,
    tonuAmount: 0,
    allInRevenue: 1000,
    coordinatorNotes: null,
    driverType: null,
    pickupCityState: null,
    pickupWindow: null,
    deliveryCityState: null,
    deliveryWindow: null,
    dropLotName: null,
    legs: [],
    ...o
  };
}

function checklistState(row: ViewBoardLoadRow, key: string): string | undefined {
  return deriveLoadChecklist(row)
    .groups.flatMap((g) => g.items)
    .find((i) => i.key === key)?.state;
}

// key → the status at which the alert engine fires it + the backing flag field.
const SHARED: Array<{ key: string; status: string; flag: keyof ViewBoardLoadRow }> = [
  { key: "BOL_MATCH", status: "PICKED_UP", flag: "bolMatchTask" },
  { key: "ADVISE_PU_ETA", status: "DISPATCHED", flag: "pickupEtaAdvised" },
  { key: "ADVISE_PU_ARRIVAL", status: "PICKED_UP", flag: "pickupArrivalAdvised" },
  { key: "ADVISE_DEL_ETA", status: "PICKED_UP", flag: "deliveryEtaAdvised" },
  { key: "ADVISE_DEL_ARRIVAL", status: "DELIVERED", flag: "deliveryArrivalAdvised" },
  { key: "TASK_MG", status: "DISPATCHED", flag: "mgStatusTask" },
  { key: "TASK_TMW", status: "DISPATCHED", flag: "tmwStatusTask" },
  { key: "TASK_SCALE_BEFORE", status: "PICKED_UP", flag: "scaleBeforeTask" },
  { key: "TASK_SCALE_AFTER", status: "DELIVERED", flag: "scaleAfterTask" }
];

describe("checklist ↔ alert engine consistency (shared obligation keys)", () => {
  for (const { key, status, flag } of SHARED) {
    test(`${key}: open obligation alert ⇒ open checklist item`, () => {
      const openRow = makeRow({ status, [flag]: "NOT_DONE" } as Partial<ViewBoardLoadRow>);
      const fires = deriveLoadAlerts(openRow, CTX).some((a) => a.kind === key);
      expect(fires).toBe(true);
      expect(checklistState(openRow, key)).not.toBe("done");

      const doneRow = makeRow({ status, [flag]: "DONE" } as Partial<ViewBoardLoadRow>);
      expect(deriveLoadAlerts(doneRow, CTX).some((a) => a.kind === key)).toBe(false);
      expect(checklistState(doneRow, key)).toBe("done");
    });
  }
});
