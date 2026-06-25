import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const resolvePhase1RegionId = vi.fn();
const getBoardResponse = vi.fn();
const listAccessibleRegions = vi.fn();
const redirect = vi.fn();
const isAuthBypassed = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth
}));

vi.mock("@/lib/access", () => ({
  requireRegionAccess
}));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));

vi.mock("@/lib/scope", () => ({
  resolvePhase1RegionId
}));

vi.mock("@/server/board", () => ({
  getBoardResponse
}));
vi.mock("@/server/kpi-governance", () => ({
  listAccessibleRegions
}));

vi.mock("next/navigation", () => ({
  redirect,
  usePathname: () => "/"
}));

vi.mock("@/lib/auth-mode", () => ({
  isAuthBypassed
}));

describe("board page shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    auth.mockResolvedValue({ userId: "user-1" });
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    assertPermission.mockReturnValue(undefined);
    listAccessibleRegions.mockResolvedValue([{ id: "region-1", code: "CDC", name: "NORTHEAST" }]);
  });

  test("renders board shell with board data", async () => {
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      regionCode: "CDC",
      regionLabel: "NORTHEAST",
      date: "2026-04-29",
      dayTotals: {
        loadCount: 1,
        lineHaulTotal: "1000",
        loadedMilesTotal: "200",
        emptyMilePct: "0.1"
      },
      sections: [
        {
          type: "drop_lot",
          title: "LOT A",
          code: "CDC",
          note: "24/7 dock",
          filledCount: 1,
          dropLot: {
            id: "lot-a",
            name: "LOT A",
            city: "Westbrook",
            state: "PA",
            sortOrder: 1,
            dailyCapacity: 5,
            slipSeat: true,
            dropHookRequired: true
          },
          loads: [
            {
              id: "load-1",
              threePlRefNumber: "REF-1",
              status: "BOOKED",
              routeId: null,
              loadNumber: null,
              pickupNumber: null,
              shipperName: null,
              pickupCityState: null,
              pickupWindow: null,
              receiverName: null,
              deliveryCityState: null,
              deliveryWindow: null,
              lineHaulRate: "1000",
              loadedMiles: "200",
              puDeadheadMiles: "10",
              delDeadheadMiles: "20",
              totalTripMiles: "230",
              negotiableMiles: "210",
              loadedRpm: "3.5",
              dropLotName: "LOT A"
            }
          ]
        },
        {
          type: "drop_lot",
          title: "LOT FULL",
          code: "FULL",
          note: null,
          filledCount: 5,
          dropLot: {
            id: "lot-full",
            name: "LOT FULL",
            city: "Pittsburgh",
            state: "PA",
            sortOrder: 2,
            dailyCapacity: 5,
            slipSeat: false,
            dropHookRequired: false
          },
          loads: []
        },
        {
          type: "drop_lot",
          title: "LOT OVER",
          code: "OVER",
          note: null,
          filledCount: 6,
          dropLot: {
            id: "lot-over",
            name: "LOT OVER",
            city: "Erie",
            state: "PA",
            sortOrder: 3,
            dailyCapacity: 5,
            slipSeat: false,
            dropHookRequired: false
          },
          loads: []
        },
        { type: "adhoc", title: "LTL", code: "LTL", filledCount: 0, dropLot: null, loads: [] },
        { type: "canceled", title: "CANCELED / TONU", filledCount: 0, dropLot: null, loads: [] }
      ]
    });

    const HomePage = (await import("@/app/page")).default;
    const markup = renderToStaticMarkup(await HomePage({ searchParams: { date: "2026-04-29" } }));
    expect(markup).toContain("db-sidebar");
    expect(markup).toContain(">Backhaul<");
    expect(markup).toContain("NORTHEAST");
    expect(markup).toContain("Daily Tracker");
    expect(markup).toContain("LOT A");
    expect(markup).toContain("24/7 dock");
    expect(markup).toContain("REF-1");
    expect(markup).toContain("db-side-nav");
    expect(markup).toContain("PU City, ST");
    expect(markup).toContain("DEL City, ST");
    expect(markup).toContain("Ldd RPM");
    expect(markup).toContain("class=\"db-section-code mono\"");
    expect(markup).not.toContain("class=\"db-brand-mark\"");
    expect(markup).toContain("class=\"db-side-wordmark\"");
    expect(markup).toContain("class=\"db-side-sub\"");
    expect(markup).toContain("Co-Pilot");
    expect(markup).toContain("class=\"db-side-brand\"");
    expect(markup).toContain("aria-label=\"Primary navigation\"");
    expect(markup).toContain("aria-label=\"Switch to light mode\"");
    expect(markup).toContain("class=\"db-cap mono\"");
    expect(markup).not.toContain(">Route<");
    expect(markup).not.toContain(">Load #<");
    expect(markup).not.toContain(">PU #<");
    expect(markup).toContain(">Neg Mi<");
  }, 15000);

  test("renders fallback section labels", async () => {
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-29",
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      },
      sections: [
        { type: "adhoc", title: "LTL", code: "LTL", filledCount: 0, dropLot: null, loads: [] },
        { type: "canceled", title: "CANCELED / TONU", filledCount: 0, dropLot: null, loads: [] }
      ]
    });

    const HomePage = (await import("@/app/page")).default;
    const markup = renderToStaticMarkup(await HomePage({ searchParams: { date: "2026-04-29" } }));
    expect(markup).toContain("LTL");
    expect(markup).toContain("CANCELED / TONU");
  });

  test("renders empty state when no section has loads", async () => {
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-29",
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      },
      sections: [
        { type: "adhoc", title: "LTL", code: "LTL", filledCount: 0, dropLot: null, loads: [] },
        { type: "canceled", title: "CANCELED / TONU", filledCount: 0, dropLot: null, loads: [] }
      ]
    });

    const HomePage = (await import("@/app/page")).default;
    const markup = renderToStaticMarkup(await HomePage({ searchParams: { date: "2026-04-29" } }));
    expect(markup).toContain("No loads booked for 2026-04-29");
    expect(markup).toContain("Use the copilot to drop a rate con and start an intake.");
    expect(markup).toContain("LTL");
    expect(markup).toContain("CANCELED / TONU");
  });

  test("renders error state when board load fails", async () => {
    getBoardResponse.mockRejectedValue(new Error("db unavailable"));
    const HomePage = (await import("@/app/page")).default;
    const markup = renderToStaticMarkup(await HomePage({ searchParams: { date: "2026-04-29" } }));
    expect(markup).toContain("Unable to load board data right now.");
  });

  test("uses ET calendar day when date query is invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T02:00:00.000Z"));
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-28",
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      },
      sections: []
    });

    const HomePage = (await import("@/app/page")).default;
    await HomePage({ searchParams: { date: "invalid" } });
    expect(getBoardResponse).toHaveBeenCalledWith({
      regionId: "region-1",
      date: "2026-04-28"
    });
    vi.useRealTimers();
  });

  test("supports promise-shaped searchParams", async () => {
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-29",
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      },
      sections: []
    });

    const HomePage = (await import("@/app/page")).default;
    await HomePage({ searchParams: Promise.resolve({ date: "2026-04-29" }) });
    expect(getBoardResponse).toHaveBeenCalledWith({
      regionId: "region-1",
      date: "2026-04-29"
    });
  });

  test("renders forbidden state for region policy denials", async () => {
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden for region"));
    const HomePage = (await import("@/app/page")).default;
    const markup = renderToStaticMarkup(await HomePage({ searchParams: { date: "2026-04-29" } }));
    expect(markup).toContain("Forbidden");
  });
});
