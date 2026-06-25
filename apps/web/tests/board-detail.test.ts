import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  resolveUserNames: vi.fn(),
  getAuditHistory: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  runInRegionScope: async (_regionId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ load: { findFirst: mocks.findFirst } })
}));

vi.mock("@/server/audit-read", () => ({
  resolveUserNames: mocks.resolveUserNames,
  getAuditHistory: mocks.getAuditHistory
}));

function baseRow() {
  return {
    id: "load-1",
    status: "DISPATCHED",
    createdById: "user-1",
    threePlRefNumber: "RXO-1",
    routeId: "RT-1",
    loadNumber: "LD-1",
    pickupNumber: "PU-1",
    pickupNumbers: ["PU-1"],
    shipperName: "Shipper",
    pickupCity: "Carlisle",
    pickupState: "PA",
    pickupWindow: "06:00",
    receiverName: "Receiver",
    deliveryCity: "Albany",
    deliveryState: "NY",
    deliveryWindow: "14:00",
    lineHaulRate: new Prisma.Decimal("1000"),
    loadedMiles: new Prisma.Decimal("200"),
    puDeadheadMiles: new Prisma.Decimal("10"),
    delDeadheadMiles: new Prisma.Decimal("20"),
    totalTripMiles: new Prisma.Decimal("230"),
    negotiableMiles: new Prisma.Decimal("210"),
    loadedRpm: new Prisma.Decimal("5"),
    emptyMilePct: new Prisma.Decimal("0.1304"),
    pickupDriverAssigned: "Driver",
    tractorTrailer1: "T-1",
    tractorTrailer2: "TR-1",
    commodity: "Beverages",
    equipmentNeeds: "53 DV",
    mgStatus: "LOADED",
    tmwStatus: "ASSIGNED",
    mgStatusTask: "NOT_DONE",
    tmwStatusTask: "NOT_DONE",
    scaleBeforeTask: "NOT_DONE",
    scaleAfterTask: "NOT_DONE",
    coordinatorNotes: null,
    attentionNote: null,
    attentionSeverity: "INFO",
    driverType: "PTP",
    podStatus: "NOT_REQUESTED",
    dropLot: { name: "RLY1" },
    broker: { name: "RXO" },
    rateConfirmation: {
      id: "rc-1",
      sourceFileUrl: "https://example.com/files/RXO_44230.pdf",
      parseState: "EXTRACTED",
      parseConfidence: new Prisma.Decimal("0.9600")
    },
    legs: [],
    createdAt: new Date("2026-04-28T16:22:00.000Z"),
    updatedAt: new Date("2026-04-29T19:34:00.000Z")
  };
}

describe("getLoadDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserNames.mockResolvedValue(new Map([["user-1", "Christopher McDaniel"]]));
    mocks.getAuditHistory.mockResolvedValue([
      { actorName: "System", action: "STATUS_CHANGE", timestamp: "2026-04-29T19:34:00.000Z" }
    ]);
  });

  test("computes NBY = line haul ÷ total system miles and resolves audit names", async () => {
    mocks.findFirst.mockResolvedValue(baseRow());
    const { getLoadDetail } = await import("@/server/board-detail");
    const payload = await getLoadDetail({ regionId: "region-1", loadId: "load-1" });

    expect(payload).not.toBeNull();
    // 1000 / 230 = 4.347826...
    expect(Number(payload!.nby)).toBeCloseTo(4.347826, 5);
    expect(payload!.loadedRpm).toBe("5");
    expect(payload!.createdByName).toBe("Christopher McDaniel");
    expect(payload!.lastUpdatedByName).toBe("System");
    expect(payload!.lastUpdatedAction).toBe("STATUS_CHANGE");
    expect(payload!.sectionCode).toBe("RLY1");
  });

  test("returns null NBY when there are no total trip miles", async () => {
    mocks.findFirst.mockResolvedValue({ ...baseRow(), totalTripMiles: null });
    const { getLoadDetail } = await import("@/server/board-detail");
    const payload = await getLoadDetail({ regionId: "region-1", loadId: "load-1" });
    expect(payload!.nby).toBeNull();
  });

  test("falls back to null audit fields when no history exists", async () => {
    mocks.findFirst.mockResolvedValue(baseRow());
    mocks.resolveUserNames.mockResolvedValue(new Map());
    mocks.getAuditHistory.mockResolvedValue([]);
    const { getLoadDetail } = await import("@/server/board-detail");
    const payload = await getLoadDetail({ regionId: "region-1", loadId: "load-1" });
    expect(payload!.createdByName).toBeNull();
    expect(payload!.lastUpdatedByName).toBeNull();
    expect(payload!.lastUpdatedAction).toBeNull();
  });

  test("returns null when the load is not found", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const { getLoadDetail } = await import("@/server/board-detail");
    const payload = await getLoadDetail({ regionId: "region-1", loadId: "missing" });
    expect(payload).toBeNull();
  });
});
