import { beforeEach, describe, expect, test, vi } from "vitest";

const processQueueEnvelope = vi.fn();

vi.mock("@/server/queue-consumer", () => ({
  processQueueEnvelope
}));

describe("POST /api/internal/queue/consume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WORKER_SHARED_SECRET;
  });

  test("accepts valid envelope payload", async () => {
    processQueueEnvelope.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/internal/queue/consume/route");
    const response = await POST(
      new Request("http://localhost/api/internal/queue/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelope: {
            contractVersion: "v1",
            payload: {
              regionId: "region-1",
              weekIso: "2026-W18",
              entityId: "rc-1",
              eventType: "PARSE_RATE_CON"
            }
          }
        })
      })
    );
    expect(response.status).toBe(202);
  });

  test("rejects unauthenticated calls in production even when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.WORKER_SHARED_SECRET;
    const { POST } = await import("@/app/api/internal/queue/consume/route");
    const response = await POST(
      new Request("http://localhost/api/internal/queue/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelope: {
            contractVersion: "v1",
            payload: { regionId: "region-1", weekIso: "2026-W18", entityId: "rc-1", eventType: "PARSE_RATE_CON" }
          }
        })
      })
    );
    expect(response.status).toBe(403);
    vi.unstubAllEnvs();
  });

  test("rejects request when worker secret is missing", async () => {
    process.env.WORKER_SHARED_SECRET = "shh";
    const { POST } = await import("@/app/api/internal/queue/consume/route");
    const response = await POST(
      new Request("http://localhost/api/internal/queue/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelope: {
            contractVersion: "v1",
            payload: {
              regionId: "region-1",
              weekIso: "2026-W18",
              entityId: "rc-1",
              eventType: "PARSE_RATE_CON"
            }
          }
        })
      })
    );
    expect(response.status).toBe(403);
  });
});

