import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

vi.mock("@/server/region-config", () => ({
  getRegionConfig: vi.fn().mockResolvedValue({ emptyPctAmber: 15, emptyPctRed: 25 })
}));

describe("board server contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("orders drop-lot sections by sortOrder and groups adhoc/canceled buckets", async () => {
    const tx = {
      dropLot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "lot-2",
            name: "RLY3",
            city: "Westbrook",
            state: "PA",
            sortOrder: 1,
            dailyCapacity: 5,
            slipSeat: true,
            dropHookRequired: true
          },
          {
            id: "lot-1",
            name: "CDC",
            city: "Carlisle",
            state: "PA",
            sortOrder: 2,
            dailyCapacity: 8,
            slipSeat: false,
            dropHookRequired: false
          }
        ])
      },
      load: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "active-lot",
            status: "BOOKED",
            dropLotId: "lot-2",
            dropLot: { id: "lot-2", name: "RLY3" },
            bookingDate: new Date("2026-04-29T01:00:00.000Z"),
            createdAt: new Date("2026-04-29T01:00:00.000Z"),
            threePlRefNumber: "R1",
            routeId: "route-1",
            loadNumber: "L1",
            pickupNumber: "P1",
            shipperName: "Shipper",
            pickupCity: "A",
            pickupState: "PA",
            pickupWindow: "AM",
            receiverName: "Receiver",
            deliveryCity: "B",
            deliveryState: "PA",
            deliveryWindow: "PM",
            lineHaulRate: new Prisma.Decimal("1000"),
            loadedMiles: new Prisma.Decimal("200"),
            puDeadheadMiles: new Prisma.Decimal("10"),
            delDeadheadMiles: new Prisma.Decimal("20"),
            totalTripMiles: new Prisma.Decimal("230"),
            negotiableMiles: new Prisma.Decimal("210"),
            loadedRpm: new Prisma.Decimal("5")
          },
          {
            id: "active-adhoc",
            status: "BOOKED",
            dropLotId: null,
            dropLot: null,
            bookingDate: new Date("2026-04-29T02:00:00.000Z"),
            createdAt: new Date("2026-04-29T02:00:00.000Z"),
            threePlRefNumber: "R2",
            routeId: null,
            loadNumber: null,
            pickupNumber: null,
            shipperName: null,
            pickupCity: null,
            pickupState: null,
            pickupWindow: null,
            receiverName: null,
            deliveryCity: null,
            deliveryState: null,
            deliveryWindow: null,
            lineHaulRate: new Prisma.Decimal("500"),
            loadedMiles: new Prisma.Decimal("100"),
            puDeadheadMiles: new Prisma.Decimal("5"),
            delDeadheadMiles: new Prisma.Decimal("5"),
            totalTripMiles: new Prisma.Decimal("110"),
            negotiableMiles: new Prisma.Decimal("105"),
            loadedRpm: new Prisma.Decimal("5")
          },
          {
            id: "canceled-1",
            status: "CANCELED",
            dropLotId: "lot-1",
            dropLot: { id: "lot-1", name: "CDC" },
            bookingDate: new Date("2026-04-29T03:00:00.000Z"),
            createdAt: new Date("2026-04-29T03:00:00.000Z"),
            threePlRefNumber: "R3",
            routeId: null,
            loadNumber: null,
            pickupNumber: null,
            shipperName: null,
            pickupCity: null,
            pickupState: null,
            pickupWindow: null,
            receiverName: null,
            deliveryCity: null,
            deliveryState: null,
            deliveryWindow: null,
            lineHaulRate: new Prisma.Decimal("400"),
            loadedMiles: new Prisma.Decimal("80"),
            puDeadheadMiles: new Prisma.Decimal("0"),
            delDeadheadMiles: new Prisma.Decimal("0"),
            totalTripMiles: new Prisma.Decimal("80"),
            negotiableMiles: new Prisma.Decimal("80"),
            loadedRpm: new Prisma.Decimal("5")
          }
        ])
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    const { getBoardResponse } = await import("@/server/board");
    const response = await getBoardResponse({ regionId: "region-1", date: "2026-04-29" });

    expect(response.sections[0].type).toBe("drop_lot");
    expect(response.sections[0].dropLot?.name).toBe("RLY3");
    expect(response.sections[1].dropLot?.name).toBe("CDC");
    expect(response.sections[2].type).toBe("adhoc");
    expect(response.sections[2].loads).toHaveLength(1);
    expect(response.sections[3].type).toBe("deliveries");
    expect(response.sections[4].type).toBe("canceled");
    expect(response.sections[4].loads).toHaveLength(1);
    expect(response.dayTotals.loadCount).toBe(2);
  });

  test("returns empty sections and zero totals when no loads found", async () => {
    const tx = {
      dropLot: {
        findMany: vi.fn().mockResolvedValue([])
      },
      load: {
        findMany: vi.fn().mockResolvedValue([])
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    const { getBoardResponse } = await import("@/server/board");
    const response = await getBoardResponse({ regionId: "region-1", date: "2026-04-29" });
    expect(response.sections).toHaveLength(5);
    expect(response.sections[0].type).toBe("adhoc");
    expect(response.sections[1].type).toBe("deliveries");
    expect(response.sections[2].type).toBe("canceled");
    expect(response.dayTotals.loadCount).toBe(0);
    expect(response.dayTotals.emptyMilePct).toBeNull();
  });

  test("folds no-drop-lot loads into LTL drop-lot section when LTL lot exists", async () => {
    const tx = {
      dropLot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "lot-ltl",
            name: "LTL",
            code: "LTL",
            city: "Carlisle",
            state: "PA",
            sortOrder: 1,
            dailyCapacity: 2,
            slipSeat: false,
            dropHookRequired: false
          }
        ])
      },
      load: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "active-ltl-1",
            status: "BOOKED",
            dropLotId: null,
            dropLot: null,
            bookingDate: new Date("2026-04-29T02:00:00.000Z"),
            createdAt: new Date("2026-04-29T02:00:00.000Z"),
            threePlRefNumber: "R2",
            routeId: null,
            loadNumber: null,
            pickupNumber: null,
            shipperName: null,
            pickupCity: null,
            pickupState: null,
            pickupWindow: null,
            receiverName: null,
            deliveryCity: null,
            deliveryState: null,
            deliveryWindow: null,
            lineHaulRate: new Prisma.Decimal("500"),
            loadedMiles: new Prisma.Decimal("100"),
            puDeadheadMiles: new Prisma.Decimal("5"),
            delDeadheadMiles: new Prisma.Decimal("5"),
            totalTripMiles: new Prisma.Decimal("110"),
            negotiableMiles: new Prisma.Decimal("105"),
            loadedRpm: new Prisma.Decimal("5")
          }
        ])
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    const { getBoardResponse } = await import("@/server/board");
    const response = await getBoardResponse({ regionId: "region-1", date: "2026-04-29" });

    expect(response.sections.some((section) => section.type === "adhoc")).toBe(false);
    expect(response.sections[0].type).toBe("drop_lot");
    expect(response.sections[0].dropLot?.name).toBe("LTL");
    expect(response.sections[0].filledCount).toBe(1);
    expect(response.sections[0].loads).toHaveLength(1);
  });

  test("uses America/New_York boundaries for date filtering", async () => {
    const loadFindMany = vi.fn().mockResolvedValue([]);
    const tx = {
      dropLot: {
        findMany: vi.fn().mockResolvedValue([])
      },
      load: {
        findMany: loadFindMany
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    const { getBoardResponse } = await import("@/server/board");
    await getBoardResponse({ regionId: "region-1", date: "2026-04-29" });

    const callArg = loadFindMany.mock.calls[0][0];
    expect(callArg.where.bookingDate.gte.toISOString()).toBe("2026-04-29T04:00:00.000Z");
    expect(callArg.where.bookingDate.lt.toISOString()).toBe("2026-04-30T04:00:00.000Z");
  });

  test("surfaces loads delivering on the viewed day in a deliveries section, excluded from totals", async () => {
    const loadFindMany = vi
      .fn()
      // First call: loads booked today (none).
      .mockResolvedValueOnce([])
      // Second call: loads delivering today (booked another day).
      .mockResolvedValueOnce([
        {
          id: "del-1",
          status: "BOOKED",
          dropLotId: null,
          dropLot: null,
          deliveryDate: new Date("2026-04-29T12:00:00.000Z")
        }
      ]);
    const tx = {
      dropLot: { findMany: vi.fn().mockResolvedValue([]) },
      load: { findMany: loadFindMany }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));

    const { getBoardResponse } = await import("@/server/board");
    const response = await getBoardResponse({ regionId: "region-1", date: "2026-04-29" });

    const deliveries = response.sections.find((section) => section.type === "deliveries");
    expect(deliveries).toBeDefined();
    expect(deliveries?.loads.map((load) => load.id)).toEqual(["del-1"]);
    // Delivery-only loads must not inflate the day's booking totals.
    expect(response.dayTotals.loadCount).toBe(0);

    // The deliveries query filters on deliveryDate for the viewed day.
    const deliveriesCall = loadFindMany.mock.calls[1][0];
    expect(deliveriesCall.where.deliveryDate.gte.toISOString()).toBe("2026-04-29T04:00:00.000Z");
    expect(deliveriesCall.where.deliveryDate.lt.toISOString()).toBe("2026-04-30T04:00:00.000Z");
  });
});
