import { beforeEach, describe, expect, test, vi } from "vitest";

const drainQueues = vi.fn();

vi.mock("@/server/queue-drain", () => ({
  drainQueues
}));

describe("/api/internal/queue/drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WORKER_SHARED_SECRET;
    drainQueues.mockResolvedValue({ processed: 0, failed: 0, deleted: 0, byQueue: [] });
  });

  test("drains when no shared secret is configured (dev)", async () => {
    const { GET } = await import("@/app/api/internal/queue/drain/route");
    const response = await GET(new Request("http://localhost/api/internal/queue/drain"));
    expect(response.status).toBe(200);
    expect(drainQueues).toHaveBeenCalled();
  });

  test("rejects unauthenticated calls in production even when no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.WORKER_SHARED_SECRET;
    const { GET } = await import("@/app/api/internal/queue/drain/route");
    const response = await GET(new Request("http://localhost/api/internal/queue/drain"));
    expect(response.status).toBe(403);
    expect(drainQueues).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  test("rejects when the shared secret is set but missing/incorrect", async () => {
    process.env.WORKER_SHARED_SECRET = "shh";
    const { GET } = await import("@/app/api/internal/queue/drain/route");
    const response = await GET(new Request("http://localhost/api/internal/queue/drain"));
    expect(response.status).toBe(403);
    expect(drainQueues).not.toHaveBeenCalled();
  });

  test("accepts the x-worker-secret header", async () => {
    process.env.WORKER_SHARED_SECRET = "shh";
    const { POST } = await import("@/app/api/internal/queue/drain/route");
    const response = await POST(
      new Request("http://localhost/api/internal/queue/drain", {
        method: "POST",
        headers: { "x-worker-secret": "shh" }
      })
    );
    expect(response.status).toBe(200);
    expect(drainQueues).toHaveBeenCalled();
  });

  test("accepts the Vercel Cron Authorization bearer", async () => {
    process.env.WORKER_SHARED_SECRET = "shh";
    const { GET } = await import("@/app/api/internal/queue/drain/route");
    const response = await GET(
      new Request("http://localhost/api/internal/queue/drain", {
        headers: { authorization: "Bearer shh" }
      })
    );
    expect(response.status).toBe(200);
    expect(drainQueues).toHaveBeenCalled();
  });
});
