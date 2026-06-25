import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const resolvePhase1RegionId = vi.fn();
const isAuthBypassed = vi.fn();
const getKpiDashboard = vi.fn();
const assertPermission = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));
vi.mock("@/lib/scope", () => ({ resolvePhase1RegionId }));
vi.mock("@/lib/auth-mode", () => ({ isAuthBypassed }));
vi.mock("@/server/kpi-dashboard", () => ({ getKpiDashboard }));

describe("GET /api/kpi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    assertPermission.mockReturnValue(undefined);
    getKpiDashboard.mockResolvedValue({
      contractVersion: "v1",
      weekIso: "2026-W17",
      comparisonWeekIso: null,
      comparisonMode: "wow",
      cards: [],
      lanes: [],
      trend: [],
      chartCatalog: {
        weeklyRevenueTrend: [],
        emptyMilePctTrend: [],
        mileMaxRpmTrend: [],
        deadheadMixTrend: [],
        revenueSplitTrend: [],
        tonuEventsTrend: []
      },
      laneDrilldowns: [],
      availableFilters: {
        lanes: [],
        brokers: [],
        lots: [],
        severities: ["INFO", "WARN", "ACTION_REQUIRED"]
      },
      activeFilters: {},
      alerts: [],
      comparisonInsights: [],
      reportMeta: {
        generatedAtIso: new Date().toISOString(),
        regionId: "region-1"
      },
      activeRegionId: "region-1",
      mileMaxMissingInbound: true,
      managementNotes: [],
      rules: []
    });
  });

  test("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/kpi/route");
    const response = await GET(new Request("http://localhost/api/kpi?weekIso=2026-W17"));
    expect(response.status).toBe(401);
  });

  test("returns 400 for invalid weekIso", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/kpi/route");
    const response = await GET(new Request("http://localhost/api/kpi?weekIso=bad"));
    expect(response.status).toBe(400);
  });

  test("returns 403 for policy denials", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { GET } = await import("@/app/api/kpi/route");
    const response = await GET(new Request("http://localhost/api/kpi?weekIso=2026-W17"));
    expect(response.status).toBe(403);
  });

  test("returns kpi payload for valid request", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/kpi/route");
    const response = await GET(new Request("http://localhost/api/kpi?weekIso=2026-W17"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ weekIso: "2026-W17" });
  });

  test("returns 500 when kpi payload violates contract", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    getKpiDashboard.mockResolvedValueOnce({ weekIso: "2026-W17" });
    const { GET } = await import("@/app/api/kpi/route");
    const response = await GET(new Request("http://localhost/api/kpi?weekIso=2026-W17"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "KPI payload contract mismatch" });
  });
});
