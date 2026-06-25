import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope,
  prisma: {
    auditLog: {
      findMany: vi.fn().mockResolvedValue([])
    }
  }
}));

describe("kpi dashboard services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("maps snapshot metrics into KPI cards and trend empty percentages", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          weekIso: "2026-W17",
          loadCount: 10,
          lineHaulRevenue: 10000,
          totalAllInRevenue: 10900,
          totalTonuAmount: 0,
          fuelSurchargeAmount: "900",
          totalLoadedMiles: 2500,
          totalTripMiles: 2650,
          mileMaxRpm: "4.11",
          emptyMilePct: 0.058
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          weekIso: "2026-W16",
          loadCount: 8,
          lineHaulRevenue: 9000,
          totalAllInRevenue: 9600,
          totalTonuAmount: 0,
          fuelSurchargeAmount: "600",
          totalLoadedMiles: 2000,
          totalTripMiles: 2150,
          mileMaxRpm: "4.46",
          emptyMilePct: 0.067
        },
        {
          weekIso: "2026-W17",
          loadCount: 10,
          lineHaulRevenue: 10000,
          totalAllInRevenue: 10900,
          totalTonuAmount: 0,
          fuelSurchargeAmount: "900",
          totalLoadedMiles: 2500,
          totalTripMiles: 2650,
          mileMaxRpm: "4.11",
          emptyMilePct: 0.058
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const tx = {
      $queryRaw: queryRaw
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) =>
      callback(tx)
    );

    const { getKpiDashboard } = await import("@/server/kpi-dashboard");
    const payload = await getKpiDashboard({ regionId: "region-1", weekIso: "2026-W17" });

    const loadedMilesCard = payload.cards.find((card) => card.key === "loadedMiles");
    const emptyPctCard = payload.cards.find((card) => card.key === "emptyPct");
    expect(loadedMilesCard?.value).toBe("2500");
    expect(emptyPctCard?.value).toBe("5.8");
    expect(payload.trend.find((point) => point.week === "W17")?.empty ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("normalizes lane keys and includes canceled loads with movement", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          status: "BOOKED",
          pickupCity: " Pittsburgh ",
          pickupState: "pa",
          deliveryCity: "Carlisle",
          deliveryState: "PA",
          lineHaulRate: new Prisma.Decimal("1000"),
          loadedMiles: new Prisma.Decimal("200"),
          puDeadheadMiles: new Prisma.Decimal("10"),
          delDeadheadMiles: new Prisma.Decimal("5"),
          fscAmount: new Prisma.Decimal("100"),
          tonuAmount: new Prisma.Decimal("0"),
          brokerId: null,
          dropLotId: null
        },
        {
          status: "CANCELED",
          pickupCity: "PITTSBURGH",
          pickupState: "PA",
          deliveryCity: "CARLISLE",
          deliveryState: "PA",
          lineHaulRate: new Prisma.Decimal("5000"),
          loadedMiles: new Prisma.Decimal("1000"),
          puDeadheadMiles: new Prisma.Decimal("0"),
          delDeadheadMiles: new Prisma.Decimal("0"),
          fscAmount: new Prisma.Decimal("0"),
          tonuAmount: new Prisma.Decimal("0"),
          brokerId: null,
          dropLotId: null
        }
      ])
      .mockResolvedValueOnce([
        {
          originCity: "PITTSBURGH",
          originState: "PA",
          destinationCity: "CARLISLE",
          destinationState: "PA",
          targetRate: new Prisma.Decimal("950")
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const tx = {
      $queryRaw: queryRaw
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) =>
      callback(tx)
    );

    const { getLaneScorecard } = await import("@/server/kpi-dashboard");
    const lanes = await getLaneScorecard({ regionId: "region-1", weekIso: "2026-W17" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.loads).toBe(2);
    expect(lanes[0]?.status).toBe("ON_TARGET");
  });
});
