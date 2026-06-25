import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const resolvePhase1RegionId = vi.fn();
const isAuthBypassed = vi.fn();
const getRateConfirmationActivity = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));
vi.mock("@/lib/scope", () => ({ resolvePhase1RegionId }));
vi.mock("@/lib/auth-mode", () => ({ isAuthBypassed }));
vi.mock("@/server/rate-confirmation-activity", () => ({ getRateConfirmationActivity }));

describe("GET /api/rate-confirmations/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    assertPermission.mockReturnValue(undefined);
    getRateConfirmationActivity.mockResolvedValue({ pending: [], ready: [], recent: [] });
  });

  test("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/rate-confirmations/activity/route");
    const response = await GET(new Request("http://localhost/api/rate-confirmations/activity?date=2026-04-29"));
    expect(response.status).toBe(401);
  });

  test("returns 400 for invalid date", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/rate-confirmations/activity/route");
    const response = await GET(new Request("http://localhost/api/rate-confirmations/activity?date=invalid"));
    expect(response.status).toBe(400);
  });

  test("returns 403 for policy denials", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { GET } = await import("@/app/api/rate-confirmations/activity/route");
    const response = await GET(new Request("http://localhost/api/rate-confirmations/activity?date=2026-04-29"));
    expect(response.status).toBe(403);
  });

  test("returns activity payload", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    getRateConfirmationActivity.mockResolvedValue({
      pending: [{ id: "rc-1", parseState: "QUEUED", reviewDecision: "APPROVED" }],
      ready: [],
      recent: []
    });
    const { GET } = await import("@/app/api/rate-confirmations/activity/route");
    const response = await GET(new Request("http://localhost/api/rate-confirmations/activity?date=2026-04-29"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pending: [{ id: "rc-1", parseState: "QUEUED", reviewDecision: "APPROVED" }]
    });
  });

  test("uses explicit region query when provided", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/rate-confirmations/activity/route");
    const response = await GET(new Request("http://localhost/api/rate-confirmations/activity?date=2026-04-29&regionId=region-9"));
    expect(response.status).toBe(200);
    expect(requireRegionAccess).toHaveBeenCalledWith("user-1", "region-9");
    expect(getRateConfirmationActivity).toHaveBeenCalledWith({ regionId: "region-9", date: "2026-04-29" });
  });
});
