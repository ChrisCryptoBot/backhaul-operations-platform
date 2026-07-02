import { describe, expect, test } from "vitest";
import type { BoardLoadRow } from "@/lib/board-types";
import { mapBoardRowToView, resolveDriverLabel } from "@/lib/ui/board-mappers";
import { deriveLoadAlerts } from "@/lib/ui/load-alerts";

const CTX = { emptyPctAmber: 15, emptyPctRed: 25 };

function makeBoardRow(overrides: Partial<BoardLoadRow> = {}): BoardLoadRow {
  return {
    id: "load-1",
    rateConfirmationId: "rc-1",
    threePlRefNumber: "RXO-1",
    status: "BOOKED",
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
    routeId: "route-1",
    loadNumber: "LD1",
    pickupNumber: "PU1",
    pickupNumbers: ["PU1"],
    brokerName: "Broker",
    brokerRepName: null,
    mgStatusTask: "DONE",
    tmwStatusTask: "DONE",
    pickupDriverAssigned: null,
    deliveryDriver: null,
    tractorTrailer1: null,
    tractorTrailer2: null,
    shipperName: "Shipper",
    commodity: null,
    equipmentNeeds: null,
    equipmentType: null,
    equipmentAccessory: null,
    equipmentOtherText: null,
    pickupCityState: "Utica, NY",
    pickupWindow: null,
    puStatusPreset: "OTHER",
    puStatusCustom: null,
    receiverName: "Leesport DC",
    deliveryCityState: "Leesport, PA",
    deliveryDate: null,
    deliveryWindow: null,
    deliveryApptType: null,
    deliveryWindowStartIso: null,
    deliveryWindowEndIso: null,
    delStatusPreset: "OTHER",
    delStatusCustom: null,
    podStatus: null,
    lineHaulRate: "1180.0000",
    fscAmount: "0.0000",
    tonuAmount: "0.0000",
    allInRevenue: "1180.0000",
    loadedMiles: "268.0000",
    puDeadheadMiles: "12.0000",
    delDeadheadMiles: "6.0000",
    totalTripMiles: "286.0000",
    negotiableMiles: "280.0000",
    loadedRpm: "4.4030",
    nby: "4.1259",
    emptyMilePct: "0.0580",
    coordinatorNotes: null,
    driverType: null,
    dropLotName: "CDC",
    legs: [],
    ...overrides
  };
}

describe("resolveDriverLabel (Phase 3)", () => {
  test("prefers the rostered code when the FK is resolved", () => {
    expect(resolveDriverLabel("REES2", "R. Reese", "old free text")).toEqual({
      label: "REES2",
      rostered: true,
      code: "REES2",
      fullName: "R. Reese"
    });
  });

  test("falls back to free text verbatim when no roster identity", () => {
    expect(resolveDriverLabel(null, null, "J. Doe")).toEqual({
      label: "J. Doe",
      rostered: false,
      code: null,
      fullName: null
    });
  });

  test("returns a null label when nothing is set (or free text is blank)", () => {
    expect(resolveDriverLabel(null, null, null).label).toBeNull();
    expect(resolveDriverLabel(undefined, undefined, "   ").label).toBeNull();
  });
});

describe("board mapper — Phase 3 parity fields", () => {
  test("passes rostered-driver, PU-appt, and leg-driver fields through to the view row", () => {
    const view = mapBoardRowToView(
      makeBoardRow({
        pickupDriverAssigned: "free text pu",
        pickupDriverId: "drv-1",
        pickupDriverCode: "SCHM2",
        pickupDriverFullName: "S. Schmidt",
        deliveryDriverId: "drv-2",
        deliveryDriverCode: "WAIR",
        deliveryDriverFullName: "W. Airhart",
        pickupApptType: "FIRM_APPT",
        pickupWindowStartIso: "2026-07-03T12:00:00.000Z",
        pickupWindowEndIso: "2026-07-03T18:00:00.000Z",
        legs: [
          {
            id: "leg-1",
            legIndex: 1,
            legType: "SHUTTLE",
            driverName: null,
            driverId: "drv-3",
            driverCode: "REES2",
            driverFullName: "R. Reese",
            startCity: "Utica",
            startState: "NY",
            endCity: "Leesport",
            endState: "PA",
            legMiles: "120.0000",
            notes: null,
            etaAtIso: "2026-07-03T14:30:00.000Z",
            arrivalAtIso: null,
            trailer: null,
            trailerHookConfirmed: "NOT_DONE"
          }
        ]
      })
    );

    expect(view.pickupDriverId).toBe("drv-1");
    expect(view.pickupDriverCode).toBe("SCHM2");
    expect(view.pickupDriverFullName).toBe("S. Schmidt");
    expect(view.deliveryDriverCode).toBe("WAIR");
    // Free text is preserved untouched alongside the FK resolution.
    expect(view.pickupDriverAssigned).toBe("free text pu");
    expect(view.pickupApptType).toBe("FIRM_APPT");
    expect(view.pickupWindowStartIso).toBe("2026-07-03T12:00:00.000Z");
    expect(view.pickupWindowEndIso).toBe("2026-07-03T18:00:00.000Z");
    expect(view.legs[0]).toMatchObject({ driverId: "drv-3", driverCode: "REES2", driverFullName: "R. Reese" });
  });

  test("a pre-Phase-3 row (no new fields) maps with nulls — contract only extended", () => {
    const view = mapBoardRowToView(makeBoardRow({ pickupDriverAssigned: "J. Doe" }));
    expect(view.pickupDriverId).toBeNull();
    expect(view.pickupDriverCode).toBeNull();
    expect(view.deliveryDriverCode).toBeNull();
    expect(view.pickupApptType).toBeNull();
    expect(view.pickupDriverAssigned).toBe("J. Doe");
  });
});

describe("load-alerts on the extended view row", () => {
  test("still computes, and a truly uncovered BOOKED load raises COVERAGE_GAP", () => {
    const view = mapBoardRowToView(makeBoardRow());
    const kinds = deriveLoadAlerts(view, CTX).map((alert) => alert.kind);
    expect(kinds).toContain("COVERAGE_GAP");
  });

  test("a rostered-FK-only driver (no free text) counts as coverage", () => {
    const view = mapBoardRowToView(
      makeBoardRow({ pickupDriverId: "drv-1", pickupDriverCode: "REES2", pickupDriverFullName: "R. Reese" })
    );
    const kinds = deriveLoadAlerts(view, CTX).map((alert) => alert.kind);
    expect(kinds).not.toContain("COVERAGE_GAP");
  });
});
