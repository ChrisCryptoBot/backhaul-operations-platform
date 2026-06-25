import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const resolvePhase1RegionId = vi.fn();
const getLoadDetail = vi.fn();
const isAuthBypassed = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));
vi.mock("@/lib/scope", () => ({ resolvePhase1RegionId }));
vi.mock("@/server/board-detail", () => ({ getLoadDetail }));
vi.mock("@/lib/auth-mode", () => ({ isAuthBypassed }));

describe("GET /api/board/load/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
  });

  test("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/board/load/[loadId]/route");
    const response = await GET(new Request("http://localhost/api/board/load/load-1"), { params: { loadId: "load-1" } });
    expect(response.status).toBe(401);
  });

  test("returns 403 for policy denials", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { GET } = await import("@/app/api/board/load/[loadId]/route");
    const response = await GET(new Request("http://localhost/api/board/load/load-1"), { params: { loadId: "load-1" } });
    expect(response.status).toBe(403);
  });

  test("returns 404 when load is missing", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    getLoadDetail.mockResolvedValue(null);
    const { GET } = await import("@/app/api/board/load/[loadId]/route");
    const response = await GET(new Request("http://localhost/api/board/load/load-1"), { params: { loadId: "load-1" } });
    expect(response.status).toBe(404);
  });

  test("returns load detail payload", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    getLoadDetail.mockResolvedValue({
      id: "load-1",
      status: "BOOKED",
      sectionCode: "LOT",
      threePlRefNumber: "REF-1",
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
      delDeadheadMiles: "10",
      totalTripMiles: "220",
      negotiableMiles: "210",
      loadedRpm: "5",
      brokerName: null,
      pickupDriverAssigned: null,
      tractorTrailer1: null,
      tractorTrailer2: null,
      commodity: null,
      equipmentNeeds: null,
      mgStatus: null,
      tmwStatus: null,
      podStatus: null,
      rateConfirmation: null,
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });
    const { GET } = await import("@/app/api/board/load/[loadId]/route");
    const response = await GET(new Request("http://localhost/api/board/load/load-1"), { params: { loadId: "load-1" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "load-1" });
  });
});
