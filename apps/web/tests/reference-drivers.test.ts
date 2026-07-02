import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

interface FakeTx {
  driver: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  directCustomer: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  dropLot: { findFirst: ReturnType<typeof vi.fn> };
  load: { count: ReturnType<typeof vi.fn> };
  loadLeg: { count: ReturnType<typeof vi.fn> };
  bookingPlanEntry: { count: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function makeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    driver: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "drv-1" }),
      create: vi.fn().mockResolvedValue({ id: "drv-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.driver
    },
    directCustomer: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "cust-1" }),
      create: vi.fn().mockResolvedValue({ id: "cust-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.directCustomer
    },
    dropLot: { findFirst: vi.fn().mockResolvedValue({ id: "lot-1" }), ...overrides.dropLot },
    load: { count: vi.fn().mockResolvedValue(0), ...overrides.load },
    loadLeg: { count: vi.fn().mockResolvedValue(0), ...overrides.loadLeg },
    bookingPlanEntry: { count: vi.fn().mockResolvedValue(0), ...overrides.bookingPlanEntry },
    auditLog: { create: vi.fn().mockResolvedValue(undefined), ...overrides.auditLog }
  };
}

function bindTx(tx: FakeTx): void {
  runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: FakeTx) => Promise<unknown>) =>
    callback(tx)
  );
}

const DRIVER_FIELDS = {
  code: "REES2",
  fullName: "R. Reese",
  phone: null,
  homeDropLotId: null,
  active: true,
  attributes: ["SHUTTLE"],
  scheduleDays: ["MON", "TUE", "WED", "THU", "FRI"],
  scheduleStart: "05:00",
  scheduleTimeZone: "America/New_York",
  scheduleNote: null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("server/reference — driver action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("listDrivers filters soft-deleted rows and maps the home drop lot", async () => {
    const tx = makeTx({
      driver: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "drv-1",
            code: "REES2",
            fullName: "R. Reese",
            phone: null,
            active: true,
            homeDropLotId: "lot-1",
            homeDropLot: { id: "lot-1", name: "Baldwinsville", code: "GELBA" },
            attributes: ["SHUTTLE"],
            scheduleDays: ["MON", "TUE", "WED", "THU", "FRI"],
            scheduleStart: "05:00",
            scheduleTimeZone: "America/New_York",
            scheduleNote: null,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-02T00:00:00.000Z")
          }
        ]),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { listDrivers } = await import("@/server/reference");
    const drivers = await listDrivers({ regionId: "region-1" });

    const where = tx.driver.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ regionId: "region-1", deletedAt: null });
    expect(drivers).toHaveLength(1);
    expect(drivers[0]).toMatchObject({
      id: "drv-1",
      code: "REES2",
      homeDropLot: { id: "lot-1", code: "GELBA" },
      scheduleStart: "05:00"
    });
  });

  test("createDriver persists fields and writes an audit log", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createDriver } = await import("@/server/reference");
    const result = await createDriver({ regionId: "region-1", actorId: "u1", fields: DRIVER_FIELDS });

    expect(tx.driver.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ regionId: "region-1", code: "REES2", scheduleStart: "05:00" })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityType: "Driver", action: "REFERENCE_DRIVER_CREATE", actorId: "u1" })
      })
    );
    expect(result).toEqual({ id: "drv-new" });
  });

  test("createDriver surfaces a duplicate region+code as 'already exists'", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test"
    });
    const tx = makeTx({
      driver: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn().mockRejectedValue(duplicate),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { createDriver } = await import("@/server/reference");
    await expect(createDriver({ regionId: "region-1", actorId: "u1", fields: DRIVER_FIELDS })).rejects.toThrow(
      /already exists/
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  test("createDriver refuses a home drop lot outside the region", async () => {
    const tx = makeTx({ dropLot: { findFirst: vi.fn().mockResolvedValue(null) } });
    bindTx(tx);

    const { createDriver } = await import("@/server/reference");
    await expect(
      createDriver({
        regionId: "region-1",
        actorId: "u1",
        fields: { ...DRIVER_FIELDS, homeDropLotId: "lot-elsewhere" }
      })
    ).rejects.toThrow(/not found/);
    expect(tx.driver.create).not.toHaveBeenCalled();
  });

  test("updateDriver throws when the driver is not in region", async () => {
    const tx = makeTx({
      driver: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), update: vi.fn() }
    });
    bindTx(tx);

    const { updateDriver } = await import("@/server/reference");
    await expect(
      updateDriver({ regionId: "region-1", actorId: "u1", driverId: "missing", fields: { active: false } })
    ).rejects.toThrow(/not found/);
    expect(tx.driver.update).not.toHaveBeenCalled();
  });

  test("softDeleteDriver blocks removal while loads or legs still reference the driver", async () => {
    const tx = makeTx({
      load: { count: vi.fn().mockResolvedValue(2) },
      loadLeg: { count: vi.fn().mockResolvedValue(1) }
    });
    bindTx(tx);

    const { softDeleteDriver } = await import("@/server/reference");
    await expect(
      softDeleteDriver({ regionId: "region-1", actorId: "u1", driverId: "drv-1", reason: "left fleet" })
    ).rejects.toThrow(/in use by 3/);
    expect(tx.driver.update).not.toHaveBeenCalled();
  });

  test("softDeleteDriver sets deletedAt and audits when unreferenced", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { softDeleteDriver } = await import("@/server/reference");
    await softDeleteDriver({ regionId: "region-1", actorId: "u1", driverId: "drv-1", reason: "left fleet" });

    expect(tx.driver.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "drv-1" }, data: { deletedAt: expect.any(Date) } })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "REFERENCE_DRIVER_DELETE", reason: "left fleet" })
      })
    );
  });
});

describe("server/reference — direct-customer action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("createDirectCustomer persists cadence and writes an audit log", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createDirectCustomer } = await import("@/server/reference");
    const result = await createDirectCustomer({
      regionId: "region-1",
      actorId: "u1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: { name: "SEALED AIR", cadenceCount: 1, cadencePeriod: "DAY", notes: null } as any
    });

    expect(tx.directCustomer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ regionId: "region-1", name: "SEALED AIR", cadenceCount: 1, cadencePeriod: "DAY" })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityType: "DirectCustomer", action: "REFERENCE_DIRECT_CUSTOMER_CREATE" })
      })
    );
    expect(result).toEqual({ id: "cust-new" });
  });

  test("updateDirectCustomer throws when the customer is not in region", async () => {
    const tx = makeTx({
      directCustomer: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), update: vi.fn() }
    });
    bindTx(tx);

    const { updateDirectCustomer } = await import("@/server/reference");
    await expect(
      updateDirectCustomer({ regionId: "region-1", actorId: "u1", directCustomerId: "missing", fields: { name: "X" } })
    ).rejects.toThrow(/not found/);
    expect(tx.directCustomer.update).not.toHaveBeenCalled();
  });

  test("softDeleteDirectCustomer sets deletedAt and audits", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { softDeleteDirectCustomer } = await import("@/server/reference");
    await softDeleteDirectCustomer({ regionId: "region-1", actorId: "u1", directCustomerId: "cust-1", reason: "contract ended" });

    expect(tx.directCustomer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cust-1" }, data: { deletedAt: expect.any(Date) } })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "REFERENCE_DIRECT_CUSTOMER_DELETE", reason: "contract ended" })
      })
    );
  });
});
