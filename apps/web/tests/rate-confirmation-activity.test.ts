import { beforeEach, describe, expect, test, vi } from "vitest";

const runInRegionScope = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

describe("rate confirmation activity service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("uses rolling 24h window for recent list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "rc-day",
          parseState: "QUEUED",
          reviewDecision: "APPROVED",
          hasLoad: false,
          updatedAt: new Date("2026-04-30T10:00:00.000Z")
        },
        {
          id: "rc-rejected",
          parseState: "EXTRACTED",
          reviewDecision: "REJECTED",
          hasLoad: false,
          updatedAt: new Date("2026-04-30T10:30:00.000Z")
        },
        {
          id: "rc-linked",
          parseState: "QUEUED",
          reviewDecision: "APPROVED",
          hasLoad: true,
          updatedAt: new Date("2026-04-30T10:40:00.000Z")
        }
      ])
      .mockResolvedValueOnce([
        {
          id: "rc-recent",
          parseState: "EXTRACTED",
          reviewDecision: "APPROVED",
          hasLoad: true,
          updatedAt: new Date("2026-04-30T11:00:00.000Z")
        }
      ]);

    const tx = {
      $queryRaw: queryRaw
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) =>
      callback(tx)
    );

    const { getRateConfirmationActivity } = await import("@/server/rate-confirmation-activity");
    const result = await getRateConfirmationActivity({ regionId: "region-1", date: "2026-04-30" });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(result.pending).toHaveLength(1);
    expect(result.ready).toHaveLength(0);
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]?.id).toBe("rc-recent");
    expect(result.recent[0]?.reviewDecision).toBe("APPROVED");
    expect(result.recent[0]?.hasLoad).toBe(true);
    vi.useRealTimers();
  });
});
