import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const resolvePhase1RegionId = vi.fn();
const getBoardResponse = vi.fn();
const moveBoardLoad = vi.fn();
const setLoadTonuLifecycle = vi.fn();
const setBoardLoadStatus = vi.fn();
const updateBoardLoadFields = vi.fn();
const softDeleteBoardLoad = vi.fn();
const isAuthBypassed = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth
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
  getBoardResponse,
  moveBoardLoad,
  setLoadTonuLifecycle,
  setBoardLoadStatus,
  updateBoardLoadFields,
  softDeleteBoardLoad
}));

vi.mock("@/lib/auth-mode", () => ({
  isAuthBypassed
}));

describe("GET /api/board", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-29",
      sections: [],
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      }
    });
  });

  test("returns 401 for unauthenticated requests", async () => {
    auth.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=2026-04-29"));
    expect(response.status).toBe(401);
  });

  test("returns 400 for invalid date query", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=bad-date"));
    expect(response.status).toBe(400);
  });

  test("returns 400 when date query is missing", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board"));
    expect(response.status).toBe(400);
  });

  test("returns 403 for policy denials", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden for region"));
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=2026-04-29"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden" });
  });

  test("returns board payload for valid requests", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=2026-04-29"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.date).toBe("2026-04-29");
    expect(getBoardResponse).toHaveBeenCalledWith({
      regionId: "region-1",
      date: "2026-04-29"
    });
  });

  test("uses explicit region query when provided", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=2026-04-29&regionId=region-2"));
    expect(response.status).toBe(200);
    expect(requireRegionAccess).toHaveBeenCalledWith("user-1", "region-2");
    expect(getBoardResponse).toHaveBeenCalledWith({
      regionId: "region-2",
      date: "2026-04-29"
    });
  });

  test("falls back in bypass mode when region lookup fails", async () => {
    isAuthBypassed.mockReturnValue(true);
    auth.mockResolvedValue({ userId: null });
    resolvePhase1RegionId.mockRejectedValue(new Error("not seeded"));
    const { GET } = await import("@/app/api/board/route");
    const response = await GET(new Request("http://localhost/api/board?date=bad-date"));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/board", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthBypassed.mockReturnValue(false);
    auth.mockResolvedValue({ userId: "user-1" });
    resolvePhase1RegionId.mockResolvedValue("region-1");
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    getBoardResponse.mockResolvedValue({
      regionId: "region-1",
      date: "2026-04-29",
      sections: [],
      dayTotals: {
        loadCount: 0,
        lineHaulTotal: "0",
        loadedMilesTotal: "0",
        emptyMilePct: null
      }
    });
    moveBoardLoad.mockResolvedValue(undefined);
    setLoadTonuLifecycle.mockResolvedValue(undefined);
    setBoardLoadStatus.mockResolvedValue(undefined);
    updateBoardLoadFields.mockResolvedValue(undefined);
    softDeleteBoardLoad.mockResolvedValue(undefined);
  });

  test("moves loads across sections", async () => {
    const { POST } = await import("@/app/api/board/route");
    const response = await POST(
      new Request("http://localhost/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move",
          date: "2026-04-29",
          loadId: "load-1",
          targetSectionId: "lot-1"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(moveBoardLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        loadId: "load-1",
        targetSectionId: "lot-1"
      })
    );
  });

  test("updates tonu lifecycle", async () => {
    const { POST } = await import("@/app/api/board/route");
    const response = await POST(
      new Request("http://localhost/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "tonu",
          date: "2026-04-29",
          loadId: "load-1",
          isTonu: true,
          tonuAmount: "200.00"
        })
      })
    );
    expect(response.status).toBe(200);
    expect(setLoadTonuLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        loadId: "load-1",
        isTonu: true,
        tonuAmount: "200.00"
      })
    );
  });

  test("rejects delete without reason", async () => {
    const { POST } = await import("@/app/api/board/route");
    const response = await POST(
      new Request("http://localhost/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          date: "2026-04-29",
          loadId: "load-1"
        })
      })
    );
    expect(response.status).toBe(400);
    expect(softDeleteBoardLoad).not.toHaveBeenCalled();
  });

  test("accepts spec-aligned PU/DEL enums in field updates", async () => {
    const { POST } = await import("@/app/api/board/route");
    const response = await POST(
      new Request("http://localhost/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-fields",
          date: "2026-04-29",
          loadId: "load-1",
          fields: {
            puStatusPreset: "ETA_TO_PU_DEL",
            delStatusPreset: "DONE"
          }
        })
      })
    );
    expect(response.status).toBe(200);
    expect(updateBoardLoadFields).toHaveBeenCalledWith(
      expect.objectContaining({
        loadId: "load-1",
        fields: { puStatusPreset: "ETA_TO_PU_DEL", delStatusPreset: "DONE" }
      })
    );
  });
});
