import { describe, expect, test, vi, beforeEach } from "vitest";
import type { BoardResponse } from "@/lib/board-types";

const mocks = vi.hoisted(() => ({
  getBoardResponse: vi.fn(),
  getEffectiveFscRate: vi.fn(async (): Promise<{ toString(): string }> => ({ toString: () => "0.55" }))
}));

vi.mock("@/server/board", () => ({ getBoardResponse: mocks.getBoardResponse }));
vi.mock("@/server/fsc", () => ({ getEffectiveFscRate: mocks.getEffectiveFscRate }));

import { buildBoardContextDigest, collectAttentionItems } from "@/server/copilot/context";

const ctx = { userId: "u1", regionId: "r1", role: "COORDINATOR" as const, boardDate: "2026-06-18" };

const board = {
  regionId: "r1",
  date: "2026-06-18",
  dayTotals: {
    loadCount: 2,
    lineHaulTotal: "1000",
    fscTotal: "0",
    tonuTotal: "0",
    allInTotal: "1000",
    loadedMilesTotal: "200",
    emptyMilePct: "0.1",
    nby: "5"
  },
  config: { emptyPctAmber: 15, emptyPctRed: 25 },
  sections: [
    {
      type: "drop_lot",
      title: "CDC",
      code: "CDC",
      filledCount: 3,
      dropLot: { id: "lot-1", name: "CDC", code: "CDC", note: null, city: "Carlisle", state: "PA", sortOrder: 1, dailyCapacity: 2, slipSeat: false, dropHookRequired: false },
      loads: [
        { id: "l1", threePlRefNumber: "3P-1", loadNumber: null, status: "BOOKED", attentionSeverity: "URGENT", podStatus: null, lateCancelFailedNote: "verify temp", shipperName: "Acme", receiverName: "BigBox" },
        { id: "l2", threePlRefNumber: "3P-2", loadNumber: null, status: "BOOKED", attentionSeverity: "INFO", podStatus: "UPLOADED", lateCancelFailedNote: null, shipperName: "X", receiverName: "Y" }
      ]
    }
  ]
} as unknown as BoardResponse;

describe("copilot live board context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveFscRate.mockResolvedValue({ toString: () => "0.55" });
  });

  test("buildBoardContextDigest produces a bounded, grounded snapshot", async () => {
    mocks.getBoardResponse.mockResolvedValue(board);
    const digest = await buildBoardContextDigest(ctx);
    expect(digest).toContain("LIVE BOARD CONTEXT for 2026-06-18");
    expect(digest).toContain("2 loads");
    expect(digest).toContain("OVER CAPACITY");
    expect(digest).toContain("Flagged loads");
    expect(digest).toContain("3P-1");
    expect(digest).toContain("URGENT");
    expect(digest).toContain("Current FSC rate (this week): 0.55");
    // An INFO load with an uploaded POD is not flagged.
    expect(digest).not.toContain("3P-2");
  });

  test("buildBoardContextDigest is best-effort: returns empty string if the board can't be read", async () => {
    mocks.getBoardResponse.mockRejectedValue(new Error("db down"));
    const digest = await buildBoardContextDigest(ctx);
    expect(digest).toBe("");
  });

  test("collectAttentionItems returns only flagged loads", () => {
    const items = collectAttentionItems(board);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ref: "3P-1", attentionSeverity: "URGENT", note: "verify temp" });
  });
});
