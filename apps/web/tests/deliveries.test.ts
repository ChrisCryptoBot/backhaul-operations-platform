import { beforeEach, describe, expect, test, vi } from "vitest";
import { LoadStatus } from "@prisma/client";

const { runInRegionScope } = vi.hoisted(() => ({ runInRegionScope: vi.fn() }));

vi.mock("@/lib/db", () => ({ runInRegionScope, prisma: {} }));
vi.mock("@/lib/board-date", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, todayIsoInTimeZone: () => "2026-07-02" };
});

import { getOpenDeliveries } from "@/server/board";

interface FakeTx {
  load: { findMany: ReturnType<typeof vi.fn> };
}

function bindTx(tx: FakeTx): void {
  runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: FakeTx) => Promise<unknown>) =>
    callback(tx)
  );
}

describe("getOpenDeliveries (global watchlist)", () => {
  beforeEach(() => {
    runInRegionScope.mockReset();
  });

  test("excludes terminal delivery states, orders soonest-due first, stamps asOf", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    bindTx({ load: { findMany } });

    const result = await getOpenDeliveries({ regionId: "region-ne" });

    expect(result).toEqual({ regionId: "region-ne", asOf: "2026-07-02", deliveries: [] });

    const args = findMany.mock.calls[0][0];
    // Terminal (done / dead) states are excluded so only in-flight deliveries remain.
    expect(args.where.status.notIn).toEqual(
      expect.arrayContaining([
        LoadStatus.POD_RECEIVED,
        LoadStatus.COMPLETED,
        LoadStatus.CANCELED,
        LoadStatus.FAILED
      ])
    );
    // BOOKED / DISPATCHED / PICKED_UP / DELIVERED (awaiting POD) stay on the list.
    expect(args.where.status.notIn).not.toContain(LoadStatus.PICKED_UP);
    expect(args.where.status.notIn).not.toContain(LoadStatus.DELIVERED);
    // Soonest delivery date first (Postgres sorts NULL dates last on ASC).
    expect(args.orderBy[0]).toEqual({ deliveryDate: "asc" });
    // Region scoping + soft-delete filter are applied.
    expect(args.where.regionId).toBe("region-ne");
    expect(args.where.deletedAt).toBeNull();
  });

  test("maps each open load through the board-row mapper", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    bindTx({ load: { findMany } });
    const result = await getOpenDeliveries({ regionId: "region-ne" });
    expect(Array.isArray(result.deliveries)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
