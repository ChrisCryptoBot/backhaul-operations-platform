import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ userId: "user-1" })),
  isAuthBypassed: vi.fn(() => false),
  resolvePhase1RegionId: vi.fn(async () => "region-1"),
  requireRegionAccess: vi.fn(async () => ({ role: "REGIONAL_MANAGER" })),
  assertPermission: vi.fn(),
  listDrivers: vi.fn(async () => [] as unknown[]),
  createDriver: vi.fn(async () => ({ id: "drv-new" })),
  updateDriver: vi.fn(async () => undefined),
  softDeleteDriver: vi.fn(async () => undefined),
  listDirectCustomers: vi.fn(async () => [] as unknown[]),
  createDirectCustomer: vi.fn(async () => ({ id: "cust-new" })),
  updateDirectCustomer: vi.fn(async () => undefined),
  softDeleteDirectCustomer: vi.fn(async () => undefined)
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
  listDrivers: mocks.listDrivers,
  createDriver: mocks.createDriver,
  updateDriver: mocks.updateDriver,
  softDeleteDriver: mocks.softDeleteDriver,
  listDirectCustomers: mocks.listDirectCustomers,
  createDirectCustomer: mocks.createDirectCustomer,
  updateDirectCustomer: mocks.updateDirectCustomer,
  softDeleteDirectCustomer: mocks.softDeleteDirectCustomer
}));

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/reference/drivers route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.isAuthBypassed.mockReturnValue(false);
    mocks.resolvePhase1RegionId.mockResolvedValue("region-1");
    mocks.requireRegionAccess.mockResolvedValue({ role: "REGIONAL_MANAGER" });
  });

  test("GET lists drivers behind REFERENCE_DATA:READ", async () => {
    const { GET } = await import("@/app/api/reference/drivers/route");
    const response = await GET(new Request("http://test/api/reference/drivers"));

    expect(response.status).toBe(200);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      resource: "REFERENCE_DATA",
      action: "READ"
    });
    const payload = (await response.json()) as { regionId: string; drivers: unknown[] };
    expect(payload).toMatchObject({ regionId: "region-1", drivers: [] });
  });

  test("GET returns 401 without a user", async () => {
    mocks.auth.mockResolvedValueOnce({ userId: null } as unknown as { userId: string });
    const { GET } = await import("@/app/api/reference/drivers/route");
    const response = await GET(new Request("http://test/api/reference/drivers"));
    expect(response.status).toBe(401);
  });

  test("POST create_driver enforces WRITE, applies defaults, returns the refreshed list", async () => {
    const { POST } = await import("@/app/api/reference/drivers/route");
    const response = await POST(
      postRequest("http://test/api/reference/drivers", {
        action: "create_driver",
        driver: { code: "REES2", fullName: "R. Reese" }
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.assertPermission).toHaveBeenCalledWith(expect.anything(), {
      resource: "REFERENCE_DATA",
      action: "WRITE"
    });
    expect(mocks.createDriver).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        actorId: "user-1",
        fields: expect.objectContaining({
          code: "REES2",
          fullName: "R. Reese",
          active: true,
          attributes: [],
          scheduleDays: [],
          scheduleStart: null
        })
      })
    );
    expect(mocks.listDrivers).toHaveBeenCalled();
  });

  test("POST rejects an invalid payload with 400", async () => {
    const { POST } = await import("@/app/api/reference/drivers/route");
    const response = await POST(
      postRequest("http://test/api/reference/drivers", { action: "create_driver", driver: { code: "" } })
    );
    expect(response.status).toBe(400);
    expect(mocks.createDriver).not.toHaveBeenCalled();
  });

  test("POST maps 'in use' to 409 and 'not found' to 404", async () => {
    const { POST } = await import("@/app/api/reference/drivers/route");

    mocks.softDeleteDriver.mockRejectedValueOnce(
      new Error("Driver is in use by 3 load record(s) and cannot be removed.")
    );
    const conflict = await POST(
      postRequest("http://test/api/reference/drivers", { action: "delete_driver", driverId: "drv-1", reason: "x" })
    );
    expect(conflict.status).toBe(409);

    mocks.updateDriver.mockRejectedValueOnce(new Error("Driver not found."));
    const missing = await POST(
      postRequest("http://test/api/reference/drivers", {
        action: "update_driver",
        driverId: "missing",
        fields: { active: false }
      })
    );
    expect(missing.status).toBe(404);
  });

  test("POST maps a duplicate code to 409", async () => {
    const { POST } = await import("@/app/api/reference/drivers/route");
    mocks.createDriver.mockRejectedValueOnce(new Error('A driver with code "REES2" already exists in this region.'));
    const response = await POST(
      postRequest("http://test/api/reference/drivers", {
        action: "create_driver",
        driver: { code: "REES2", fullName: "R. Reese" }
      })
    );
    expect(response.status).toBe(409);
  });
});

describe("api/reference/direct-customers route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ userId: "user-1" });
    mocks.isAuthBypassed.mockReturnValue(false);
    mocks.resolvePhase1RegionId.mockResolvedValue("region-1");
    mocks.requireRegionAccess.mockResolvedValue({ role: "REGIONAL_MANAGER" });
  });

  test("GET lists direct customers behind REFERENCE_DATA:READ", async () => {
    const { GET } = await import("@/app/api/reference/direct-customers/route");
    const response = await GET(new Request("http://test/api/reference/direct-customers"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { directCustomers: unknown[] };
    expect(payload.directCustomers).toEqual([]);
  });

  test("POST create_direct_customer dispatches with a normalized cadence", async () => {
    const { POST } = await import("@/app/api/reference/direct-customers/route");
    const response = await POST(
      postRequest("http://test/api/reference/direct-customers", {
        action: "create_direct_customer",
        directCustomer: { name: "SEALED AIR", cadenceCount: 1, cadencePeriod: "DAY" }
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.createDirectCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        fields: { name: "SEALED AIR", cadenceCount: 1, cadencePeriod: "DAY", notes: null }
      })
    );
  });

  test("POST rejects a one-sided cadence with 400", async () => {
    const { POST } = await import("@/app/api/reference/direct-customers/route");
    const response = await POST(
      postRequest("http://test/api/reference/direct-customers", {
        action: "create_direct_customer",
        directCustomer: { name: "AB", cadenceCount: 10 }
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.createDirectCustomer).not.toHaveBeenCalled();
  });
});
