import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The run itself reads the database; these cases never get that far (every one is turned away at the door), so the database is a stub that fails the test if it is reached.
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: () => { throw new Error("the cron route reached the database"); } }) }));

const ENV = { BRIDGE_SUPABASE_URL: "https://bridge.test.invalid", BRIDGE_SUPABASE_SERVICE_KEY: "test-key-not-real", BRIDGE_CRON_SECRET: "the-right-secret" };
const saved: Record<string, string | undefined> = {};

const req = (method: "GET" | "POST", headers: Record<string, string>) => new Request("http://localhost/bridge/cron", { method, headers }) as never;

describe("the driver link's schedule can call with POST (pg_cron) or GET (Vercel cron), behind the same secret", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("turns away a wrong or missing secret on either, with a plain 401", async () => {
    const { GET, POST } = await import("../src/app/(public)/bridge/cron/route");
    expect((await POST(req("POST", { "x-bridge-cron": "wrong" }))).status).toBe(401);
    expect((await POST(req("POST", {}))).status).toBe(401);
    expect((await GET(req("GET", { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await GET(req("GET", {}))).status).toBe(401);
    // The secret in the other style's place does not count: a GET reads only the Bearer header.
    expect((await GET(req("GET", { "x-bridge-cron": "the-right-secret" }))).status).toBe(401);
  });

  it("does not exist (404) until the server holds the secret and the link's keys", async () => {
    delete process.env.BRIDGE_CRON_SECRET;
    const { GET, POST } = await import("../src/app/(public)/bridge/cron/route");
    expect((await GET(req("GET", { authorization: "Bearer the-right-secret" }))).status).toBe(404);
    expect((await POST(req("POST", { "x-bridge-cron": "the-right-secret" }))).status).toBe(404);
  });
});
