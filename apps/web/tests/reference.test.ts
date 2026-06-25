import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

interface FakeTx {
  broker: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  brokerRep: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  lane: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  dropLot: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  load: { count: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function makeTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    broker: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "broker-1" }),
      create: vi.fn().mockResolvedValue({ id: "broker-new", name: "Acme" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.broker
    },
    brokerRep: {
      findFirst: vi.fn().mockResolvedValue({ id: "rep-1" }),
      create: vi.fn().mockResolvedValue({ id: "rep-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.brokerRep
    },
    lane: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "lane-1" }),
      create: vi.fn().mockResolvedValue({ id: "lane-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.lane
    },
    dropLot: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "lot-1" }),
      create: vi.fn().mockResolvedValue({ id: "lot-new" }),
      update: vi.fn().mockResolvedValue(undefined),
      ...overrides.dropLot
    },
    load: { count: vi.fn().mockResolvedValue(0), ...overrides.load },
    auditLog: { create: vi.fn().mockResolvedValue(undefined), ...overrides.auditLog }
  };
}

function bindTx(tx: FakeTx): void {
  runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: FakeTx) => Promise<unknown>) =>
    callback(tx)
  );
}

describe("server/reference — broker action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("listBrokers filters soft-deleted rows and maps reps", async () => {
    const tx = makeTx({
      broker: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "broker-1",
            name: "Acme",
            onboardingStatus: "APPROVED",
            fscDefaultApplies: true,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-02T00:00:00.000Z"),
            brokerReps: [{ id: "rep-1", name: "Dana", email: "dana@acme.com", phone: null }]
          }
        ]),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn()
      }
    });
    bindTx(tx);

    const { listBrokers } = await import("@/server/reference");
    const brokers = await listBrokers({ regionId: "region-1" });

    const where = tx.broker.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ regionId: "region-1", deletedAt: null });
    expect(brokers).toHaveLength(1);
    expect(brokers[0]).toMatchObject({ id: "broker-1", name: "Acme", reps: [{ id: "rep-1", name: "Dana" }] });
  });

  test("createBroker persists defaults and writes an audit log", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createBroker } = await import("@/server/reference");
    const result = await createBroker({ regionId: "region-1", actorId: "u1", name: "Acme" });

    expect(tx.broker.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          regionId: "region-1",
          name: "Acme",
          onboardingStatus: "PENDING",
          fscDefaultApplies: true
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entityType: "Broker", action: "REFERENCE_BROKER_CREATE", actorId: "u1" }) })
    );
    expect(result).toEqual({ id: "broker-new", name: "Acme" });
  });

  test("updateBroker throws when the broker is not in region", async () => {
    const tx = makeTx({ broker: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), update: vi.fn() } });
    bindTx(tx);

    const { updateBroker } = await import("@/server/reference");
    await expect(
      updateBroker({ regionId: "region-1", actorId: "u1", brokerId: "missing", fields: { name: "X" } })
    ).rejects.toThrow(/not found/);
    expect(tx.broker.update).not.toHaveBeenCalled();
  });

  test("softDeleteBroker sets deletedAt and audits", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { softDeleteBroker } = await import("@/server/reference");
    await softDeleteBroker({ regionId: "region-1", actorId: "u1", brokerId: "broker-1", reason: "dup" });

    expect(tx.broker.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "broker-1" }, data: { deletedAt: expect.any(Date) } })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "REFERENCE_BROKER_DELETE", reason: "dup" }) })
    );
  });

  test("addBrokerRep verifies the parent broker is in region before creating", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { addBrokerRep } = await import("@/server/reference");
    await addBrokerRep({ regionId: "region-1", actorId: "u1", brokerId: "broker-1", name: "Dana", email: "dana@acme.com" });

    expect(tx.broker.findFirst).toHaveBeenCalled();
    expect(tx.brokerRep.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ brokerId: "broker-1", name: "Dana", email: "dana@acme.com" }) })
    );
  });

  test("addBrokerRep refuses when the broker is missing", async () => {
    const tx = makeTx({ broker: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(), create: vi.fn(), update: vi.fn() } });
    bindTx(tx);

    const { addBrokerRep } = await import("@/server/reference");
    await expect(
      addBrokerRep({ regionId: "region-1", actorId: "u1", brokerId: "missing", name: "Dana" })
    ).rejects.toThrow(/not found/);
    expect(tx.brokerRep.create).not.toHaveBeenCalled();
  });
});

describe("server/reference — lane action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("createLane persists a Decimal target and audits", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createLane } = await import("@/server/reference");
    await createLane({
      regionId: "region-1",
      actorId: "u1",
      originCity: "Carlisle",
      originState: "PA",
      destinationCity: "Boston",
      destinationState: "MA",
      targetRate: "2.15"
    });

    const data = tx.lane.create.mock.calls[0][0].data as { targetRate: Prisma.Decimal };
    expect(data.targetRate.toString()).toBe("2.15");
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "REFERENCE_LANE_CREATE" }) })
    );
  });

  test("createLane maps a unique-constraint violation to a friendly error", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test"
    });
    const tx = makeTx({
      lane: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn().mockRejectedValue(conflict) }
    });
    bindTx(tx);

    const { createLane } = await import("@/server/reference");
    await expect(
      createLane({
        regionId: "region-1",
        actorId: "u1",
        originCity: "Carlisle",
        originState: "PA",
        destinationCity: "Boston",
        destinationState: "MA",
        targetRate: "2.15"
      })
    ).rejects.toThrow(/already exists/);
  });

  test("setLaneTarget updates the rate when the lane exists", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { setLaneTarget } = await import("@/server/reference");
    await setLaneTarget({ regionId: "region-1", actorId: "u1", laneId: "lane-1", targetRate: "2.50" });

    const data = tx.lane.update.mock.calls[0][0].data as { targetRate: Prisma.Decimal };
    expect(data.targetRate.toString()).toBe("2.5");
  });

  test("setLaneTarget throws when the lane is missing", async () => {
    const tx = makeTx({ lane: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) } });
    bindTx(tx);

    const { setLaneTarget } = await import("@/server/reference");
    await expect(
      setLaneTarget({ regionId: "region-1", actorId: "u1", laneId: "missing", targetRate: "2.50" })
    ).rejects.toThrow(/not found/);
    expect(tx.lane.update).not.toHaveBeenCalled();
  });
});

describe("server/reference — drop-lot action layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("createDropLot persists fields and audits", async () => {
    const tx = makeTx();
    bindTx(tx);

    const { createDropLot } = await import("@/server/reference");
    await createDropLot({
      regionId: "region-1",
      actorId: "u1",
      fields: {
        name: "CDC",
        code: "CDC",
        note: null,
        city: "Carlisle",
        state: "PA",
        sortOrder: 1,
        dailyCapacity: 8,
        slipSeat: false,
        dropHookRequired: false
      }
    });

    expect(tx.dropLot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ regionId: "region-1", name: "CDC", city: "Carlisle" }) })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "REFERENCE_DROP_LOT_CREATE" }) })
    );
  });

  test("softDeleteDropLot blocks removal while loads still reference the lot", async () => {
    const tx = makeTx({ load: { count: vi.fn().mockResolvedValue(3) } });
    bindTx(tx);

    const { softDeleteDropLot } = await import("@/server/reference");
    await expect(
      softDeleteDropLot({ regionId: "region-1", actorId: "u1", dropLotId: "lot-1", reason: "cleanup" })
    ).rejects.toThrow(/in use by 3/);
    expect(tx.dropLot.update).not.toHaveBeenCalled();
  });

  test("softDeleteDropLot sets deletedAt when no loads reference it", async () => {
    const tx = makeTx({ load: { count: vi.fn().mockResolvedValue(0) } });
    bindTx(tx);

    const { softDeleteDropLot } = await import("@/server/reference");
    await softDeleteDropLot({ regionId: "region-1", actorId: "u1", dropLotId: "lot-1", reason: "cleanup" });

    expect(tx.dropLot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { deletedAt: expect.any(Date) } })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "REFERENCE_DROP_LOT_DELETE", reason: "cleanup" }) })
    );
  });
});
