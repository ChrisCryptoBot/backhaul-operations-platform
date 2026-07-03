import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { runInRegionScope } = vi.hoisted(() => ({ runInRegionScope: vi.fn() }));

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

vi.mock("@/server/region-config", () => ({
  getRegionConfig: vi.fn().mockResolvedValue({ emptyPctAmber: 15, emptyPctRed: 25 })
}));

import { recordLoadDisruption, DisruptionValidationError } from "@/server/disruptions";
import { moveBoardLoad, rescheduleBoardLoadDelivery, setBoardLoadStatus } from "@/server/board";

/** A minimal transaction double covering the calls the disruption paths make. */
function makeTx(load: Record<string, unknown>) {
  return {
    load: {
      findFirst: vi.fn().mockResolvedValue(load),
      update: vi.fn().mockResolvedValue({})
    },
    dropLot: {
      findFirst: vi.fn().mockResolvedValue(null)
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({})
    },
    loadDisruptionEvent: {
      create: vi.fn().mockResolvedValue({})
    }
  };
}

function bindTx(tx: ReturnType<typeof makeTx>) {
  runInRegionScope.mockImplementation(async (_regionId: string, cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
}

describe("recordLoadDisruption", () => {
  test("rejects an OTHER reason with no detail", async () => {
    const tx = makeTx({});
    await expect(
      recordLoadDisruption(tx as never, {
        loadId: "l1",
        regionId: "r1",
        weekIso: "2026-W27",
        kind: "CANCEL",
        reason: "OTHER",
        detail: "   ",
        actorId: "u1"
      })
    ).rejects.toBeInstanceOf(DisruptionValidationError);
    expect(tx.loadDisruptionEvent.create).not.toHaveBeenCalled();
  });

  test("writes the denormalized weekIso/kind and trims OTHER detail", async () => {
    const tx = makeTx({});
    await recordLoadDisruption(tx as never, {
      loadId: "l1",
      regionId: "r1",
      weekIso: "2026-W27",
      kind: "RESCHEDULE",
      reason: "OTHER",
      detail: "  dock closed  ",
      actorId: "u1"
    });
    expect(tx.loadDisruptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ weekIso: "2026-W27", kind: "RESCHEDULE", reason: "OTHER", detail: "dock closed" })
    });
  });

  test("stores null detail for a non-OTHER reason with blank detail", async () => {
    const tx = makeTx({});
    await recordLoadDisruption(tx as never, {
      loadId: "l1",
      regionId: "r1",
      weekIso: "2026-W27",
      kind: "CANCEL",
      reason: "CARRIER_NO_SHOW",
      detail: "  ",
      actorId: "u1"
    });
    expect(tx.loadDisruptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "CARRIER_NO_SHOW", detail: null })
    });
  });
});

describe("setBoardLoadStatus — cancel capture", () => {
  const baseLoad = {
    id: "l1",
    status: "BOOKED",
    weekIso: "2026-W27",
    isTONU: false,
    tonuAmount: new Prisma.Decimal(0)
  };

  test("blocks a cancel with no reason", async () => {
    const tx = makeTx(baseLoad);
    bindTx(tx);
    await expect(
      setBoardLoadStatus({ regionId: "r1", loadId: "l1", status: "CANCELED", actorId: "u1" })
    ).rejects.toBeInstanceOf(DisruptionValidationError);
    expect(tx.loadDisruptionEvent.create).not.toHaveBeenCalled();
  });

  test("records a CANCEL event with the load's weekIso", async () => {
    const tx = makeTx(baseLoad);
    bindTx(tx);
    await setBoardLoadStatus({ regionId: "r1", loadId: "l1", status: "CANCELED", actorId: "u1", reason: "CARRIER_NO_SHOW" });
    expect(tx.loadDisruptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CANCEL", reason: "CARRIER_NO_SHOW", weekIso: "2026-W27" })
    });
  });

  test("does not record a disruption for a non-cancel status change", async () => {
    const tx = makeTx(baseLoad);
    bindTx(tx);
    // FAILED is a terminal exception (not a forward-ladder advance and not CANCELED),
    // so it skips the checklist gate and records no disruption.
    await setBoardLoadStatus({ regionId: "r1", loadId: "l1", status: "FAILED", actorId: "u1" });
    expect(tx.loadDisruptionEvent.create).not.toHaveBeenCalled();
  });
});

describe("rescheduleBoardLoadDelivery — reschedule capture", () => {
  const load = { id: "l1", deliveryState: "PA", status: "BOOKED", weekIso: "2026-W27" };
  const appt = { date: "2026-07-10", windowStart: "09:00", windowEnd: "12:00", apptType: "FIRM_APPT" as const };

  test("blocks a reschedule with no reason", async () => {
    const tx = makeTx(load);
    bindTx(tx);
    await expect(
      rescheduleBoardLoadDelivery({ regionId: "r1", loadId: "l1", actorId: "u1", ...appt, reason: undefined as never })
    ).rejects.toBeInstanceOf(DisruptionValidationError);
    expect(tx.loadDisruptionEvent.create).not.toHaveBeenCalled();
  });

  test("two reschedules write two RESCHEDULE rows", async () => {
    const tx = makeTx(load);
    bindTx(tx);
    await rescheduleBoardLoadDelivery({ regionId: "r1", loadId: "l1", actorId: "u1", ...appt, reason: "PARTY_RESCHEDULE" });
    await rescheduleBoardLoadDelivery({ regionId: "r1", loadId: "l1", actorId: "u1", ...appt, reason: "NO_DOCK_TIME" });
    expect(tx.loadDisruptionEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.loadDisruptionEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ kind: "RESCHEDULE", reason: "PARTY_RESCHEDULE" })
    });
    expect(tx.loadDisruptionEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ kind: "RESCHEDULE", reason: "NO_DOCK_TIME" })
    });
  });
});

describe("moveBoardLoad — drag-to-canceled is exempt but recorded", () => {
  test("records OTHER / (drag-canceled) with no prompt", async () => {
    const tx = makeTx({ id: "l1", status: "BOOKED", weekIso: "2026-W27", dropLotId: null, isTONU: false, tonuAmount: new Prisma.Decimal(0) });
    bindTx(tx);
    await moveBoardLoad({ regionId: "r1", loadId: "l1", targetSectionId: "canceled", actorId: "u1" });
    expect(tx.loadDisruptionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "CANCEL", reason: "OTHER", detail: "(drag-canceled)" })
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
