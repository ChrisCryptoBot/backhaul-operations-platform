import { BoardShell } from "@/components/board/board-shell";
import { KpiDashboard } from "@/components/kpi/kpi-dashboard";
import { ReviewPanel } from "@/app/review/review-panel";
import type { ViewBoardResponse } from "@/lib/ui/board-mappers";
import type { ReviewRateConfirmation } from "@/server/review";

const boardFixture: ViewBoardResponse = {
  regionId: "region-1",
  regionCode: "CDC",
  regionLabel: "NORTHEAST",
  date: "2026-04-29",
  totals: {
    loads: 1,
    lineHaul: 1000,
    fsc: null,
    tonu: null,
    allIn: null,
    loadedMiles: 200,
    emptyPctRatio: 0.1,
    nby: 1.5
  },
  config: { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
  availableRegions: [],
  activeRegionId: null,
  sections: [
    {
      id: "lot-a",
      type: "drop_lot",
      title: "LOT A",
      code: "CDC",
      note: "24/7 dock",
      filledCount: 1,
      capacity: 5,
      city: "Westbrook",
      state: "PA",
      slipSeat: false,
      dropHookRequired: true,
      loads: [
        {
          id: "load-1",
          rateConfirmationId: null,
          ref: "REF-1",
          status: "BOOKED",
          shipper: "Shipper",
          receiver: "Receiver",
          lineHaul: 1000,
          loadedMi: 200,
          puDh: 10,
          delDh: 20,
          totalMi: 230,
          negMi: 210,
          loadedRpm: 5,
          nby: 1.5,
          emptyPct: 0.1,
          routeId: "route-1",
          loadNumber: "L1",
          pickupNumber: "P1",
          pickupNumbers: [],
          lateCancelFailedNote: null,
          attentionSeverity: "INFO",
          scaleBeforeTask: "NOT_DONE",
          scaleAfterTask: "NOT_DONE",
          bolMatchTask: "NOT_DONE",
          pickupEtaAdvised: "NOT_DONE",
          pickupArrivalAdvised: "NOT_DONE",
          deliveryEtaAdvised: "NOT_DONE",
          deliveryArrivalAdvised: "NOT_DONE",
          deliveryExceptionState: "NONE",
          rescheduleDriverConfirmed: "NOT_DONE",
          brokerName: null,
          brokerRepName: null,
          mgStatusTask: "NOT_DONE",
          tmwStatusTask: "NOT_DONE",
          pickupDriverAssigned: null,
          deliveryDriver: null,
          tractorTrailer1: null,
          tractorTrailer2: null,
          commodity: null,
          equipmentNeeds: null,
          equipmentType: null,
          equipmentAccessory: null,
          equipmentOtherText: null,
          puStatusPreset: "ON_TIME",
          puStatusCustom: null,
          deliveryDate: null,
          deliveryApptType: null,
          deliveryWindowStartIso: null,
          deliveryWindowEndIso: null,
          delStatusPreset: "ON_TIME",
          delStatusCustom: null,
          podStatus: null,
          fscAmount: null,
          tonuAmount: null,
          allInRevenue: null,
          coordinatorNotes: null,
          driverType: null,
          pickupCityState: "A, PA",
          pickupWindow: "AM",
          deliveryCityState: "B, PA",
          deliveryWindow: "PM",
          dropLotName: "LOT A",
          legs: []
        }
      ]
    }
  ]
};

const kpiFixture = {
  weekIso: "2026-W17",
  comparisonWeekIso: "2026-W16",
  cards: [
    { key: "loads", label: "Total Loads", value: "47", delta: 6, deltaLabel: "WoW" },
    { key: "revenue", label: "Total 3P Revenue", value: "58420", delta: 4180, deltaLabel: "WoW" },
    { key: "loadedMiles", label: "Loaded Miles", value: "12800", delta: 420, deltaLabel: "WoW" },
    { key: "emptyPct", label: "Empty Mile %", value: "5.8", delta: -0.9, deltaLabel: "WoW", inverted: true },
    { key: "mileMaxRpm", label: "MileMax RPM", value: "1.94", delta: 0.03, deltaLabel: "WoW" },
    { key: "fsc", label: "Total FSC", value: "7400", delta: -120, deltaLabel: "WoW", inverted: true },
    { key: "tender", label: "Tender Accept %", value: "82.3", delta: null, deltaLabel: "no prior", noPrior: true }
  ],
  lanes: [
    {
      lane: "Pittsburgh, PA -> Carlisle, PA",
      target: "1200",
      loads: 5,
      revenue: "6200",
      vsTarget: "75",
      emptyPct: "6.1",
      fsc: "700",
      revLoad: "1240",
      status: "ON_TARGET"
    }
  ],
  trend: [
    { week: "W06", loads: 33, rev: "45820", empty: "7.9" },
    { week: "W07", loads: 35, rev: "47060", empty: "7.6" },
    { week: "W08", loads: 34, rev: "46610", empty: "7.4" },
    { week: "W09", loads: 37, rev: "48900", empty: "7.3" },
    { week: "W10", loads: 39, rev: "50240", empty: "7.1" },
    { week: "W11", loads: 36, rev: "49180", empty: "7.0" },
    { week: "W12", loads: 38, rev: "51620", empty: "6.9" },
    { week: "W13", loads: 41, rev: "53420", empty: "6.6" },
    { week: "W14", loads: 40, rev: "52960", empty: "6.5" },
    { week: "W15", loads: 43, rev: "55100", empty: "6.2" },
    { week: "W16", loads: 45, rev: "56840", empty: "6.0" },
    { week: "W17", loads: 47, rev: "58420", empty: "5.8" }
  ],
  activeFilters: {
    weeks: 6
  },
  managementNotes: ["Empty miles improved week over week.", "Top lane stayed above target."],
  rules: [
    {
      code: "FRONT_DROP_HOOK",
      title: "Front-end drop-hook required",
      severity: "ACTION_REQUIRED",
      statement: "Live-load tenders are auto-rejected.",
      appliesTo: "RLY3, RLY2"
    }
  ]
};

const reviewFixture: ReviewRateConfirmation = {
  contractVersion: "v1",
  id: "rc-1",
  parseState: "EXTRACTED",
  reviewDecision: "PENDING",
  sourceFileUrl: "https://example.com/rc-1.pdf",
  parseConfidence: 0.94,
  loadId: null,
  extractedPayload: {
    shipperName: "Example Shipper",
    pickupCityState: "A, PA",
    deliveryCityState: "B, PA"
  },
  reviewedAt: null,
  reviewedById: null,
  reviewReason: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T00:00:00.000Z"
};

interface VisualRegressionPageProps {
  searchParams?: {
    surface?: string;
  };
}

export default function VisualRegressionPage({ searchParams }: VisualRegressionPageProps) {
  const surface = searchParams?.surface ?? "board";

  if (surface === "kpi") {
    return (
      <div data-testid="visual-kpi">
        <KpiDashboard initialData={kpiFixture} />
      </div>
    );
  }

  if (surface === "review") {
    return (
      <div data-testid="visual-review">
        <ReviewPanel initial={reviewFixture} regionId="region-1" />
      </div>
    );
  }

  return (
    <div data-testid="visual-board">
      <BoardShell board={boardFixture} />
    </div>
  );
}
