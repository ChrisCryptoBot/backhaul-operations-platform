import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const isWriteBypassed = vi.fn();
const runInRegionScope = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));
vi.mock("@/lib/auth-mode", () => ({ isWriteBypassed }));
vi.mock("@/lib/db", () => ({ runInRegionScope }));

describe("PATCH /api/kpi/lane-target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ userId: "user-1" });
    isWriteBypassed.mockReturnValue(false);
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    assertPermission.mockReturnValue(undefined);
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (tx: any) => Promise<void>) =>
      callback({
        weekSnapshot: {
          findUnique: vi.fn().mockResolvedValue({ laneIssueNotes: { notes: {}, marketRates: {} } }),
          upsert: vi.fn().mockResolvedValue(undefined)
        },
        auditLog: {
          create: vi.fn().mockResolvedValue(undefined)
        }
      })
    );
  });

  test("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue({ userId: null });
    const { PATCH } = await import("@/app/api/kpi/lane-target/route");
    const response = await PATCH(
      new Request("http://localhost/api/kpi/lane-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          weekIso: "2026-W17",
          lane: "A, PA → B, PA",
          targetRate: "2400"
        })
      })
    );
    expect(response.status).toBe(401);
  });

  test("returns 403 when permission is denied", async () => {
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { PATCH } = await import("@/app/api/kpi/lane-target/route");
    const response = await PATCH(
      new Request("http://localhost/api/kpi/lane-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          weekIso: "2026-W17",
          lane: "A, PA → B, PA",
          targetRate: "2400"
        })
      })
    );
    expect(response.status).toBe(403);
  });

  test("returns 422 when target is not a positive number", async () => {
    const { PATCH } = await import("@/app/api/kpi/lane-target/route");
    const response = await PATCH(
      new Request("http://localhost/api/kpi/lane-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          weekIso: "2026-W17",
          lane: "A, PA → B, PA",
          targetRate: "-5"
        })
      })
    );
    expect(response.status).toBe(422);
  });

  test("persists manual weekly target rate", async () => {
    const { PATCH } = await import("@/app/api/kpi/lane-target/route");
    const response = await PATCH(
      new Request("http://localhost/api/kpi/lane-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          weekIso: "2026-W17",
          lane: "A, PA → B, PA",
          targetRate: "2400"
        })
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });
});
