import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import { BoardShell } from "@/components/board/board-shell";
import { KpiDashboard } from "@/components/kpi/kpi-dashboard";
import { ReviewPanel } from "@/app/review/review-panel";
import type { ViewBoardResponse } from "@/lib/ui/board-mappers";
import type { ReviewRateConfirmation } from "@/server/review";

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
    refresh: refreshMock
  }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams()
}));

expect.extend(toHaveNoViolations);

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
          brokerName: null,
          brokerRepName: null,
          mgStatusTask: "NOT_DONE" as const,
          tmwStatusTask: "NOT_DONE" as const,
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
    { week: "W17", loads: 47, rev: "58420", empty: "5.8" },
    { week: "W16", loads: 41, rev: "54240", empty: "6.7" },
    { week: "W15", loads: 41, rev: "53420", empty: "6.6" }
  ],
  managementNotes: ["Empty miles improved week over week."],
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
    shipperName: "Example Shipper"
  },
  reviewedAt: null,
  reviewedById: null,
  reviewReason: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T00:00:00.000Z"
};

describe("ui accessibility smoke checks", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/rate-confirmations/activity")) {
          return new Response(
            JSON.stringify({
              pending: [],
              ready: [],
              recent: []
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/board/load/")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/review/")) {
          return new Response(JSON.stringify(reviewFixture), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("board shell has no obvious axe violations", async () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test("kpi dashboard has no obvious axe violations", async () => {
    const { container } = render(<KpiDashboard initialData={kpiFixture} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Trend" }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);

  test("review panel has no obvious axe violations", async () => {
    const { container } = render(<ReviewPanel initial={reviewFixture} regionId="region-1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
