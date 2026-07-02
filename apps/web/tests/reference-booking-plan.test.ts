import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();
const createLoadFromReview = vi.fn(async () => ({ loadId: "load-new" }));

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));
vi.mock("@/server/review", () => ({
  createLoadFromReview
}));

interface FakeTx {
  bookingPlanEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  driver: { findFirst: ReturnType<typeof vi.fn> };
  distributionCenter: { findFirst: ReturnType<typeof vi.fn> };
  load: { update: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

const OPEN_ENTRY = {
  id: "bpe-1",
  planDate: new Date("2026-07-03T00:00:00.000Z"),
  status: "SOURCING",
  sourcedLoadId: null,
  backhaulNote: "SEALED AIR return",
  driver: { id: "drv-1", code: "REES2" }
};

function makeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    bookingPlanEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(OPEN_ENTRY),
      create: vi.fn().mockResolvedValue({ id: "bpe-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.bookingPlanEntry
    },
    driver: { findFirst: vi.fn().mockResolvedValue({ id: "drv-1", code: "REES2" }), ...overrides.driver },
    distributionCenter: {
      findFirst: vi.fn().mockResolvedValue({ name: "Leesport DC", city: "Leesport", state: "PA" }),
      ...overrides.distributionCenter
    },
    load: { update: vi.fn().mockResolvedValue(undefined), ...overrides.load },
    auditLog: { create: vi.fn().mockResolvedValue(undefined), ...overrides.auditLog }
  };
}

function bindTx(tx: FakeTx): void {
  runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: FakeTx) => Promise<unknown>) =>
    callback(tx)
  );
}

const CREATE_FIELDS = {
  planDate: "2026-07-03",
  driverId: "drv-1",
  expectedEmptyAt: "05:00",
  emptyCity: "Utica",
  emptyState: "NY",
  emptyCityAlt: null,
  backhaulNote: "NEED BH",
  status: "NEEDS_BACKHAUL",
  puCityDh: null,
  puTimes: null,
  delCityDh: null,
  delTimes: null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("server/reference — booking-plan action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createLoadFromReview.mockResolvedValue({ loadId: "load-new" });
  });

  test("listBookingPlanEntries filters by region + planDate and maps driver/sourced load", async () => {
    const tx = makeTx({
      bookingPlanEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "bpe-1",
            planDate: new Date("2026-07-03T00:00:00.000Z"),
            driverId: "drv-1",
            driver: { id: "drv-1", code: "REES2", fullName: "R. Reese" },
            expectedEmptyAt: "05:00",
            emptyCity: "Utica",
            emptyState: "NY",
            emptyCityAlt: null,
            backhaulNote: null,
            status: "BOOKED",
            sourcedLoadId: "load-1",
            sourcedLoad: { id: "load-1", loadNumber: "LD2239297", status: "BOOKED" },
            puCityDh: null,
            puTimes: null,
            delCityDh: null,
            delTimes: null,
            createdAt: new Date("2026-07-02T00:00:00.000Z"),
            updatedAt: new Date("2026-07-02T00:00:00.000Z")
          }
        ]),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { listBookingPlanEntries } = await import("@/server/reference");
    const entries = await listBookingPlanEntries({ regionId: "region-1", planDate: "2026-07-03" });

    const where = tx.bookingPlanEntry.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ regionId: "region-1", deletedAt: null });
    expect(where.planDate).toEqual(new Date("2026-07-03T00:00:00.000Z"));
    expect(entries[0]).toMatchObject({
      planDate: "2026-07-03",
      driver: { code: "REES2" },
      sourcedLoad: { loadNumber: "LD2239297" }
    });
  });

  test("createBookingPlanEntry validates the driver, stores a DATE, and audits", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createBookingPlanEntry } = await import("@/server/reference");
    const result = await createBookingPlanEntry({ regionId: "region-1", actorId: "u1", fields: CREATE_FIELDS });

    expect(tx.driver.findFirst).toHaveBeenCalled();
    expect(tx.bookingPlanEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          regionId: "region-1",
          driverId: "drv-1",
          planDate: new Date("2026-07-03T00:00:00.000Z"),
          status: "NEEDS_BACKHAUL"
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityType: "BookingPlanEntry", action: "REFERENCE_BOOKING_PLAN_CREATE" })
      })
    );
    expect(result).toEqual({ id: "bpe-new" });
  });

  test("createBookingPlanEntry refuses a driver outside the region", async () => {
    const tx = makeTx({ driver: { findFirst: vi.fn().mockResolvedValue(null) } });
    bindTx(tx);

    const { createBookingPlanEntry } = await import("@/server/reference");
    await expect(
      createBookingPlanEntry({ regionId: "region-1", actorId: "u1", fields: CREATE_FIELDS })
    ).rejects.toThrow(/not found/);
    expect(tx.bookingPlanEntry.create).not.toHaveBeenCalled();
  });

  test("updateBookingPlanEntry throws when the entry is not in region", async () => {
    const tx = makeTx({
      bookingPlanEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { updateBookingPlanEntry } = await import("@/server/reference");
    await expect(
      updateBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "missing", fields: { status: "SOURCING" } })
    ).rejects.toThrow(/not found/);
    expect(tx.bookingPlanEntry.update).not.toHaveBeenCalled();
  });

  test("softDeleteBookingPlanEntry blocks removal of a booked line", async () => {
    const tx = makeTx({
      bookingPlanEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "bpe-1", status: "BOOKED", sourcedLoadId: "load-1" }),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { softDeleteBookingPlanEntry } = await import("@/server/reference");
    await expect(
      softDeleteBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "bpe-1", reason: "cleanup" })
    ).rejects.toThrow(/in use/);
    expect(tx.bookingPlanEntry.update).not.toHaveBeenCalled();
  });

  test("softDeleteBookingPlanEntry sets deletedAt and audits for an unbooked line", async () => {
    const tx = makeTx({
      bookingPlanEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "bpe-1", status: "SOURCING", sourcedLoadId: null }),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined)
      }
    });
    bindTx(tx);

    const { softDeleteBookingPlanEntry } = await import("@/server/reference");
    await softDeleteBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "bpe-1", reason: "not empty" });

    expect(tx.bookingPlanEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bpe-1" }, data: { deletedAt: expect.any(Date) } })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "REFERENCE_BOOKING_PLAN_DELETE", reason: "not empty" })
      })
    );
  });

  test("bookBookingPlanEntry creates a minimal Load, resolves the driver + home DC, links and flips status", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { bookBookingPlanEntry } = await import("@/server/reference");
    const result = await bookBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "bpe-1" });

    // Minimal Load via the existing review path, headed home.
    expect(createLoadFromReview).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "region-1",
        actorId: "u1",
        pickupDate: new Date("2026-07-03T00:00:00.000Z"),
        receiverName: "Leesport DC",
        fscApplies: false
      }),
      tx
    );
    // Additive follow-up: driver FK + free-text code, delivery side = home DC.
    expect(tx.load.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "load-new" },
        data: expect.objectContaining({
          pickupDriverId: "drv-1",
          pickupDriverAssigned: "REES2",
          deliveryCity: "Leesport",
          deliveryState: "PA",
          coordinatorNotes: "SEALED AIR return"
        })
      })
    );
    // Entry linked + flipped.
    expect(tx.bookingPlanEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bpe-1" },
        data: { status: "BOOKED", sourcedLoadId: "load-new" }
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "REFERENCE_BOOKING_PLAN_BOOK" })
      })
    );
    expect(result).toEqual({ loadId: "load-new" });
  });

  test("bookBookingPlanEntry rejects an already-booked entry", async () => {
    const tx = makeTx({
      bookingPlanEntry: {
        findFirst: vi.fn().mockResolvedValue({ ...OPEN_ENTRY, status: "BOOKED", sourcedLoadId: "load-1" }),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { bookBookingPlanEntry } = await import("@/server/reference");
    await expect(bookBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "bpe-1" })).rejects.toThrow(
      /already booked/
    );
    expect(createLoadFromReview).not.toHaveBeenCalled();
    expect(tx.bookingPlanEntry.update).not.toHaveBeenCalled();
  });

  test("bookBookingPlanEntry still books when the region has no distribution center", async () => {
    const tx = makeTx({ distributionCenter: { findFirst: vi.fn().mockResolvedValue(null) } });
    bindTx(tx);

    const { bookBookingPlanEntry } = await import("@/server/reference");
    const result = await bookBookingPlanEntry({ regionId: "region-1", actorId: "u1", entryId: "bpe-1" });

    expect(result).toEqual({ loadId: "load-new" });
    expect(tx.load.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliveryCity: null, deliveryState: null })
      })
    );
  });
});
