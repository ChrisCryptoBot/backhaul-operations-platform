import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";
import { ReviewConflictError, ReviewNotFoundError, ReviewValidationError } from "@/lib/review-errors";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const resolvePhase1RegionId = vi.fn();
const isAuthBypassed = vi.fn();
const getRateConfirmationForReview = vi.fn();
const approveRateConfirmationReview = vi.fn();
const rejectRateConfirmationReview = vi.fn();
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
vi.mock("@/server/review", () => ({
  getRateConfirmationForReview,
  approveRateConfirmationReview,
  rejectRateConfirmationReview
}));

describe("GET/POST /api/review/[rateConfirmationId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    assertPermission.mockReturnValue(undefined);
    getRateConfirmationForReview.mockResolvedValue({
      contractVersion: "v1",
      id: "rc-1",
      parseState: "EXTRACTED",
      reviewDecision: "APPROVED",
      sourceFileUrl: "https://example.com/rc-1.pdf",
      extractedPayload: { lineHaulRate: 1000 },
      loadId: null,
      reviewedAt: null,
      reviewedById: null,
      reviewReason: null,
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T01:00:00.000Z"
    });
    approveRateConfirmationReview.mockResolvedValue({ loadId: "load-1", alreadyExisted: false });
    rejectRateConfirmationReview.mockResolvedValue({ reviewDecision: "REJECTED" });
  });

  test("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await GET(new Request("http://localhost/api/review/rc-1"), {
      params: { rateConfirmationId: "rc-1" }
    });
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(401);
  });

  test("returns review payload", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await GET(new Request("http://localhost/api/review/rc-1"), {
      params: { rateConfirmationId: "rc-1" }
    });
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "rc-1", parseState: "EXTRACTED" });
  });

  test("returns 403 for policy denials", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { GET } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await GET(new Request("http://localhost/api/review/rc-1"), {
      params: { rateConfirmationId: "rc-1" }
    });
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(403);
  });

  test("approves review and returns 201", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { POST } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await POST(
      new Request("http://localhost/api/review/rc-1", {
        method: "POST",
        body: JSON.stringify({ action: "approve" })
      }),
      { params: { rateConfirmationId: "rc-1" } }
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ loadId: "load-1", alreadyExisted: false });
  });

  test("rejects review and returns decision state", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { POST } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await POST(
      new Request("http://localhost/api/review/rc-1", {
        method: "POST",
        body: JSON.stringify({ action: "reject", reason: "Not a valid rate confirmation" })
      }),
      { params: { rateConfirmationId: "rc-1" } }
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reviewDecision: "REJECTED" });
  });

  test("maps review validation errors to 422", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    approveRateConfirmationReview.mockRejectedValue(new ReviewValidationError("Missing pickupDate in extracted payload."));
    const { POST } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await POST(
      new Request("http://localhost/api/review/rc-1", {
        method: "POST",
        body: JSON.stringify({ action: "approve" })
      }),
      { params: { rateConfirmationId: "rc-1" } }
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(422);
  });

  test("maps review conflict errors to 409", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    approveRateConfirmationReview.mockRejectedValue(new ReviewConflictError("Rate confirmation is not ready for approval."));
    const { POST } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await POST(
      new Request("http://localhost/api/review/rc-1", {
        method: "POST",
        body: JSON.stringify({ action: "approve" })
      }),
      { params: { rateConfirmationId: "rc-1" } }
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(409);
  });

  test("maps review not-found errors to 404", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    approveRateConfirmationReview.mockRejectedValue(new ReviewNotFoundError("Rate confirmation not found."));
    const { POST } = await import("@/app/api/review/[rateConfirmationId]/route");
    const response = await POST(
      new Request("http://localhost/api/review/rc-1", {
        method: "POST",
        body: JSON.stringify({ action: "approve" })
      }),
      { params: { rateConfirmationId: "rc-1" } }
    );
    expect(response).toBeDefined();
    if (!response) {
      throw new Error("Expected response");
    }
    expect(response.status).toBe(404);
  });
});
