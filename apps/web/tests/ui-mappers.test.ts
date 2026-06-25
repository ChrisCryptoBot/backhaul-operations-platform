import { describe, expect, test } from "vitest";
import { int, money, pct, rpm } from "@/lib/ui/formatters";
import { mapStatusPresentation } from "@/lib/ui/status-map";
import { mapBoardResponseToView } from "@/lib/ui/board-mappers";
import { mapLoadDetailToView } from "@/lib/ui/drawer-mappers";
import { mapKpiDashboardToView } from "@/lib/ui/kpi-mappers";

describe("ui formatters", () => {
  test("formats numeric values and guards null", () => {
    expect(money(1180)).toBe("$1,180.00");
    expect(rpm(4.553)).toBe("4.55");
    expect(pct(0.058, { fromRatio: true })).toBe("5.8%");
    expect(int(12488.2)).toBe("12,488");
    expect(money(null)).toBe("—");
  });
});

describe("status map", () => {
  test("maps known and unknown statuses", () => {
    expect(mapStatusPresentation("POD_RECEIVED")).toMatchObject({ label: "POD RECEIVED", tone: "pod" });
    expect(mapStatusPresentation("CUSTOM")).toMatchObject({ label: "CUSTOM", tone: "unknown" });
  });
});

describe("board mapper", () => {
  test("normalizes names and decimal strings", () => {
    const view = mapBoardResponseToView({
      regionId: "region-1",
      date: "2026-04-29",
      dayTotals: {
        loadCount: 1,
        lineHaulTotal: "1180.0000",
        fscTotal: "0.0000",
        tonuTotal: "0.0000",
        allInTotal: "1180.0000",
        loadedMilesTotal: "268.0000",
        emptyMilePct: "0.0580",
        nby: "4.1259"
      },
      config: { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
      sections: [
        {
          type: "drop_lot",
          title: "CDC",
          filledCount: 1,
          dropLot: {
            id: "lot-1",
            name: "CDC",
            city: "Carlisle",
            state: "PA",
            sortOrder: 1,
            dailyCapacity: 4,
            slipSeat: false,
            dropHookRequired: false
          },
          loads: [
            {
              id: "load-1",
              rateConfirmationId: null,
              threePlRefNumber: "RXO-1",
              status: "BOOKED",
              lateCancelFailedNote: null,
              attentionSeverity: "INFO" as const,
              scaleBeforeTask: "NOT_DONE" as const,
              scaleAfterTask: "NOT_DONE" as const,
              bolMatchTask: "NOT_DONE" as const,
              pickupEtaAdvised: "NOT_DONE" as const,
              pickupArrivalAdvised: "NOT_DONE" as const,
              deliveryEtaAdvised: "NOT_DONE" as const,
              deliveryArrivalAdvised: "NOT_DONE" as const,
              deliveryExceptionState: "NONE" as const,
              rescheduleDriverConfirmed: "NOT_DONE" as const,
              routeId: null,
              loadNumber: null,
              pickupNumber: null,
              pickupNumbers: [],
              brokerName: null,
              brokerRepName: null,
              mgStatusTask: "NOT_DONE" as const,
              tmwStatusTask: "NOT_DONE" as const,
              pickupDriverAssigned: null,
              deliveryDriver: null,
              tractorTrailer1: null,
              tractorTrailer2: null,
              shipperName: "S",
              commodity: null,
              equipmentNeeds: null,
              equipmentType: null,
              equipmentAccessory: null,
              equipmentOtherText: null,
              pickupCityState: "A, PA",
              pickupWindow: null,
              puStatusPreset: "ON_TIME",
              puStatusCustom: null,
              receiverName: "R",
              deliveryCityState: "B, PA",
              deliveryDate: null,
              deliveryApptType: null,
              deliveryWindowStartIso: null,
              deliveryWindowEndIso: null,
              deliveryWindow: null,
              delStatusPreset: "ON_TIME",
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
              legs: [
                {
                  id: "leg-1",
                  legIndex: 1,
                  legType: "PTP",
                  driverName: "J. Doe",
                  startCity: "Omaha",
                  startState: "NE",
                  endCity: "Allentown",
                  endState: "PA",
                  legMiles: "286.0000",
                  notes: null,
                  etaAtIso: "2026-06-21T14:30:00.000Z",
                  arrivalAtIso: null,
                  trailer: null,
                  trailerHookConfirmed: "NOT_DONE"
                }
              ]
            }
          ]
        }
      ]
    });

    expect(view.totals.lineHaul).toBe(1180);
    expect(view.totals.nby).toBeCloseTo(4.1259, 4);
    expect(view.sections[0]?.loads[0]?.lineHaul).toBe(1180);
    expect(view.sections[0]?.loads[0]?.ref).toBe("RXO-1");
    expect(view.sections[0]?.loads[0]?.nby).toBeCloseTo(4.1259, 4);
    expect(view.sections[0]?.loads[0]?.emptyPct).toBeCloseTo(0.058, 4);
    expect(view.sections[0]?.loads[0]?.legs[0]?.etaAtIso).toBe("2026-06-21T14:30:00.000Z");
    expect(view.sections[0]?.loads[0]?.deliveryExceptionState).toBe("NONE");
    expect(view.sections[0]?.loads[0]?.rescheduleDriverConfirmed).toBe("NOT_DONE");
    expect(view.sections[0]?.loads[0]?.legs[0]?.arrivalAtIso).toBeNull();
    expect(view.config).toEqual({ emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 });
  });
});

describe("drawer mapper", () => {
  test("derives timeline state and numeric financials", () => {
    const detail = mapLoadDetailToView({
      id: "load-1",
      status: "DISPATCHED",
      sectionCode: "CDC",
      threePlRefNumber: "RXO-1",
      routeId: "R1",
      loadNumber: "L1",
      pickupNumber: "P1",
      pickupNumbers: ["P1"],
      shipperName: "S",
      pickupCityState: "A, PA",
      pickupWindow: "08:00",
      receiverName: "R",
      deliveryCityState: "B, PA",
      deliveryWindow: "10:00",
      lineHaulRate: "1000.00",
      loadedMiles: "200.00",
      puDeadheadMiles: "10.00",
      delDeadheadMiles: "8.00",
      totalTripMiles: "218.00",
      negotiableMiles: "210.00",
      loadedRpm: "5.00",
      emptyMilePct: "0.0826",
      nby: "4.5872",
      brokerName: "Broker A",
      pickupDriverAssigned: "DRV",
      tractorTrailer1: "T1",
      tractorTrailer2: "TR1",
      commodity: "Food",
      equipmentNeeds: "53DV",
      mgStatus: "Booked",
      tmwStatus: "Assigned",
      mgStatusTask: "NOT_DONE",
      tmwStatusTask: "NOT_DONE",
      scaleBeforeTask: "NOT_DONE",
      scaleAfterTask: "NOT_DONE",
      bolMatchTask: "NOT_DONE",
      pickupEtaAdvised: "NOT_DONE",
      pickupArrivalAdvised: "NOT_DONE",
      deliveryEtaAdvised: "NOT_DONE",
      deliveryArrivalAdvised: "NOT_DONE",
      deliveryExceptionState: "NONE",
      rescheduleDriverConfirmed: "NOT_DONE",
      coordinatorNotes: null,
      attentionNote: null,
      attentionSeverity: "INFO",
      driverType: null,
      podStatus: "None",
      rateConfirmation: {
        id: "rc-1",
        sourceFileUrl: "https://example.com/file.pdf",
        parseState: "EXTRACTED",
        parseConfidence: "0.9500"
      },
      legs: [
        {
          id: "leg-1",
          legIndex: 1,
          legType: "PTP",
          driverName: "DRV",
          startCity: "A",
          startState: "PA",
          endCity: "B",
          endState: "PA",
          legMiles: "200.00",
          notes: null,
          etaAtIso: "2026-04-29T03:30:00.000Z",
          arrivalAtIso: null,
          trailer: null,
          trailerHookConfirmed: "NOT_DONE"
        }
      ],
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T01:00:00.000Z",
      createdByName: "Christopher McDaniel",
      lastUpdatedByName: "System",
      lastUpdatedAction: "STATUS_CHANGE"
    });

    expect(detail.legs[0]?.etaAtIso).toBe("2026-04-29T03:30:00.000Z");
    expect(detail.legs[0]?.arrivalAtIso).toBeNull();
    expect(detail.timeline.find((x) => x.key === "BOOKED")?.state).toBe("done");
    expect(detail.timeline.find((x) => x.key === "DISPATCHED")?.state).toBe("current");
    expect(detail.financials.emptyPct).toBeCloseTo(0.0826, 6);
    expect(detail.financials.nby).toBeCloseTo(4.5872, 4);
    expect(detail.operations.tractorTrailer).toBe("T1 / TR1");
    expect(detail.operations.deliveryExceptionState).toBe("NONE");
    expect(detail.operations.rescheduleDriverConfirmed).toBe("NOT_DONE");
    expect(detail.rateConfirmation?.fileName).toBe("file.pdf");
    expect(detail.audit.createdByName).toBe("Christopher McDaniel");
    expect(detail.audit.lastUpdatedByName).toBe("System");
    expect(detail.audit.lastUpdatedAction).toBe("STATUS_CHANGE");
  });

  test("keeps drawer emptyPct nullable", () => {
    const detail = mapLoadDetailToView({
      id: "load-2",
      status: "BOOKED",
      sectionCode: null,
      threePlRefNumber: null,
      routeId: null,
      loadNumber: null,
      pickupNumber: null,
      pickupNumbers: [],
      shipperName: null,
      pickupCityState: null,
      pickupWindow: null,
      receiverName: null,
      deliveryCityState: null,
      deliveryWindow: null,
      lineHaulRate: "0",
      loadedMiles: "0",
      puDeadheadMiles: "0",
      delDeadheadMiles: "0",
      totalTripMiles: null,
      negotiableMiles: null,
      loadedRpm: null,
      emptyMilePct: null,
      nby: null,
      brokerName: null,
      pickupDriverAssigned: null,
      tractorTrailer1: null,
      tractorTrailer2: null,
      commodity: null,
      equipmentNeeds: null,
      mgStatus: null,
      tmwStatus: null,
      mgStatusTask: "NOT_DONE",
      tmwStatusTask: "NOT_DONE",
      scaleBeforeTask: "NOT_DONE",
      scaleAfterTask: "NOT_DONE",
      bolMatchTask: "NOT_DONE",
      pickupEtaAdvised: "NOT_DONE",
      pickupArrivalAdvised: "NOT_DONE",
      deliveryEtaAdvised: "NOT_DONE",
      deliveryArrivalAdvised: "NOT_DONE",
      deliveryExceptionState: "NONE",
      rescheduleDriverConfirmed: "NOT_DONE",
      coordinatorNotes: null,
      attentionNote: null,
      attentionSeverity: "INFO",
      driverType: null,
      podStatus: null,
      rateConfirmation: null,
      legs: [],
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T01:00:00.000Z",
      createdByName: null,
      lastUpdatedByName: null,
      lastUpdatedAction: null
    });
    expect(detail.financials.emptyPct).toBeNull();
    expect(detail.financials.nby).toBeNull();
    expect(detail.audit.createdByName).toBe("—");
    expect(detail.audit.lastUpdatedByName).toBe("—");
  });
});

describe("kpi mapper", () => {
  test("converts typed and string metrics consistently", () => {
    const mapped = mapKpiDashboardToView({
      weekIso: "2026-W17",
      comparisonWeekIso: "2026-W16",
      cards: [
        {
          key: "loads",
          label: "Total Loads",
          value: "47",
          delta: "6",
          deltaLabel: "+6 WoW"
        }
      ],
      lanes: [
        {
          lane: "A -> B",
          target: "1500.00",
          loads: 3,
          revenue: "4500.00",
          vsTarget: "0.00",
          emptyPct: "5.80",
          nby: "3.45",
          fsc: "220.00",
          revLoad: "1500.00",
          status: "ON_TARGET"
        }
      ],
      trend: [{ week: "W17", loads: 47, rev: "58420", empty: "5.8" }],
      managementNotes: ["Good week"],
      rules: [
        {
          code: "RULE",
          title: "Rule",
          severity: "INFO",
          statement: "Keep floor",
          appliesTo: "All"
        }
      ]
    });

    expect(mapped.cards[0]?.delta).toBe(6);
    expect(mapped.lanes[0]?.target).toBe(1500);
    expect(mapped.trend[0]?.rev).toBe(58420);
  });
});
