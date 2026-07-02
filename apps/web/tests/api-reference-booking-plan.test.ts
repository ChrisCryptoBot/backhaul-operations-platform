import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ userId: "user-1" })),
  isAuthBypassed: vi.fn(() => false),
  resolvePhase1RegionId: vi.fn(async () => "region-1"),
  requireRegionAccess: vi.fn(async () => ({ role: "REGIONAL_MANAGER" })),
  assertPermission: vi.fn(),
  listBookingPlanEntries: vi.fn(async () => [] as unknown[]),
  createBookingPlanEntry: vi.fn(async () => ({ id: "bpe-new" })),
  updateBookingPlanEntry: vi.fn(async () => undefined),
  softDeleteBookingPlanEntry: vi.fn(async () => undefined),
  bookBookingPlanEntry: vi.fn(async () => ({ loadId: "load-new" }))
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/auth-mode", () => ({ isAuthBypassed: mocks.isAuthBypassed }));
vi.mock("@/lib/scope", () => ({ resolvePhase1RegionId: mocks.resolvePhase1RegionId }));
vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess: mocks.requireRegionAccess,
    assertPermission: mocks.assertPermission
  }
}));
vi.mock("@/server/reference", () => ({
  listBookingPlanEntries: mocks.listBookingPlanEntries,
  createBookingPlanEntry: mocks.createBookingPlanEntry,
  updateBookingPlanEntry: mocks.updateBookingPlanEntry,
  softDeleteBookingPlanEntry: mocks.softDeleteBookingPlanEntry,
  bookBookingPlanEntry: mocks.bookBookingPlanEntry
}));

function postRequest(body: unknown): Request {
  return new Request("http://test/api/reference/booking-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/reference/booking-plan route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.isAuthBypassed.mockReturnValue(false);
    mocks.resolvePhase1RegionId.mockResolvedValue("region-1");
    mocks.requireRegionAccess.mockResolvedValue({ role: "REGIONAL_MANAGER" });
    mocks.bookBookingPlanEntry.mockResolvedValue({ loadId: "load-new" });
  });

  test("GET lists entries behind REFERENCE_DATA:READ and forwards planDate", async () => {
    const { GET } = await import("@/app/api/reference/booking-plan/route");
    const response = await GET(new Request("http://test/api/reference/booking-plan?planDate=2026-07-03"));

    expect(response.status).toBe(200);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      resource: "REFERENCE_DATA",
      action: "READ"
    });
    expect(mocks.listBookingPlanEntries).toHaveBeenCalledWith({ regionId: "region-1", planDate: "2026-07-03" });
  });

  test("GET without planDate lists all; a malformed planDate is a 400", async () => {
    const { GET } = await import("@/app/api/reference/booking-plan/route");

    const all = await GET(new Request("http://test/api/reference/booking-plan"));
    expect(all.status).toBe(200);
    expect(mocks.listBookingPlanEntries).toHaveBeenCalledWith({ regionId: "region-1", planDate: undefined });

    const bad = await GET(new Request("http://test/api/reference/booking-plan?planDate=07-03-2026"));
    expect(bad.status).toBe(400);
  });

  test("GET returns 401 without a user", async () => {
    mocks.auth.mockResolvedValueOnce({ userId: null } as unknown as { userId: string });
    const { GET } = await import("@/app/api/reference/booking-plan/route");
    const response = await GET(new Request("http://test/api/reference/booking-plan"));
    expect(response.status).toBe(401);
  });

  test("POST create enforces WRITE and applies null defaults", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");
    const response = await POST(
      postRequest({
        action: "create_booking_plan_entry",
        entry: { planDate: "2026-07-03", driverId: "drv-1" }
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      resource: "REFERENCE_DATA",
      action: "WRITE"
    });
    expect(mocks.createBookingPlanEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        actorId: "user-1",
        fields: expect.objectContaining({
          planDate: "2026-07-03",
          driverId: "drv-1",
          status: "NEEDS_BACKHAUL",
          expectedEmptyAt: null,
          emptyCity: null
        })
      })
    );
  });

  test("POST book returns the created load id", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");
    const response = await POST(postRequest({ action: "book_booking_plan_entry", entryId: "bpe-1" }));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { bookedLoadId: string | null };
    expect(payload.bookedLoadId).toBe("load-new");
    expect(mocks.bookBookingPlanEntry).toHaveBeenCalledWith({ regionId: "region-1", actorId: "user-1", entryId: "bpe-1" });
  });

  test("POST maps double-book to 409 and missing entry to 404", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");

    mocks.bookBookingPlanEntry.mockRejectedValueOnce(new Error("Booking plan entry is already booked."));
    const conflict = await POST(postRequest({ action: "book_booking_plan_entry", entryId: "bpe-1" }));
    expect(conflict.status).toBe(409);

    mocks.updateBookingPlanEntry.mockRejectedValueOnce(new Error("Booking plan entry not found."));
    const missing = await POST(
      postRequest({ action: "update_booking_plan_entry", entryId: "missing", fields: { status: "SOURCING" } })
    );
    expect(missing.status).toBe(404);
  });

  test("POST maps a booked-line delete to 409", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");
    mocks.softDeleteBookingPlanEntry.mockRejectedValueOnce(
      new Error("Booking plan entry is in use by its sourced load and cannot be removed.")
    );
    const response = await POST(
      postRequest({ action: "delete_booking_plan_entry", entryId: "bpe-1", reason: "cleanup" })
    );
    expect(response.status).toBe(409);
  });

  test("POST rejects an invalid payload (BOOKED on create) with 400", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");
    const response = await POST(
      postRequest({
        action: "create_booking_plan_entry",
        entry: { planDate: "2026-07-03", driverId: "drv-1", status: "BOOKED" }
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.createBookingPlanEntry).not.toHaveBeenCalled();
  });

  test("POST returns 403 when policy denies", async () => {
    const { POST } = await import("@/app/api/reference/booking-plan/route");
    const { PolicyViolationError } = await import("@/lib/policy-error");
    mocks.assertPermission.mockImplementationOnce(() => {
      throw new PolicyViolationError("denied");
    });
    const response = await POST(postRequest({ action: "book_booking_plan_entry", entryId: "bpe-1" }));
    expect(response.status).toBe(403);
    expect(mocks.bookBookingPlanEntry).not.toHaveBeenCalled();
  });
});
