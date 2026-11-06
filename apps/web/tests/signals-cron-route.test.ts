import { afterEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath } from "@/lib/auth-route";

/**
 * The schedule's door: it does not exist until the server holds the secret (404), a wrong or missing secret is a plain 401 with no detail, and the answer is counts and nothing else. The runner is
 * replaced here, so this touches no database and no other desk's rows (tests/integration/notify.integration.test.ts runs the real thing).
 */
const COUNTS = {
  workspaces: 2,
  channels: 1,
  signals: { created: 3, seen: 9, reopened: 1, resolved: 2, escalated: 0 },
  notified: { channels: 1, due: 4, sent: 4, failed: 0, waiting: 0, skipped: 0 },
  reports: { off: 0, no_channel: 0, not_due: 1, already_sent: 0, sent: 1, failed: 0, waiting: 0 },
  failed: 0
};
const runner = vi.fn(async (_o?: { deskUrl?: string | null }) => COUNTS);
vi.mock("@/server/tl/signals-cron", () => ({ runSignalsCron: (o?: { deskUrl?: string | null }) => runner(o) }));

import { POST } from "@/app/(public)/signals/cron/route";

const call = (headers: Record<string, string> = {}) => POST(new NextRequest("http://localhost:3102/signals/cron", { method: "POST", headers }));

afterEach(() => {
  delete process.env.SIGNALS_CRON_SECRET;
  runner.mockClear();
});

describe("POST /signals/cron", () => {
  test("the front door lets the schedule reach it (it checks its own secret), and only it: the signals page is not public", () => {
    expect(isPublicPath("/signals/cron")).toBe(true);
    expect(isPublicPath("/signals")).toBe(false);
    expect(isPublicPath("/signals/report")).toBe(false);
    expect(isPublicPath("/signals/cron/extra")).toBe(false);
  });

  test("404 until the server holds a secret, whatever is sent, and nothing runs", async () => {
    const res = await call({ "x-signals-cron": "anything" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "Not found." });
    expect(runner).not.toHaveBeenCalled();
  });

  test("401 with a wrong or missing secret, in the same plain words, and nothing runs", async () => {
    process.env.SIGNALS_CRON_SECRET = "right-secret-value";
    const wrong: Array<Record<string, string>> = [{},{ "x-signals-cron": "wrong" }, { "x-signals-cron": "right-secret-valuX" }, { "x-signals-cron": "right-secret-value-and-more" }, { "x-partner-cron": "right-secret-value" }];
    for (const headers of wrong) {
      const res = await call(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "Not allowed." });
    }
    expect(runner).not.toHaveBeenCalled();
  });

  test("200 with the right secret: runs once and answers counts only", async () => {
    process.env.SIGNALS_CRON_SECRET = "right-secret-value";
    const res = await call({ "x-signals-cron": "right-secret-value", host: "desk.example.com", "x-forwarded-proto": "https" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, ...COUNTS });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toMatchObject({ deskUrl: "https://desk.example.com" });
    // Numbers only below the top: no name, id, address or key anywhere in the answer.
    const leaves: unknown[] = [];
    const walk = (v: unknown) => (v && typeof v === "object" ? Object.values(v).forEach(walk) : leaves.push(v));
    walk({ ...body, ok: undefined });
    expect(leaves.filter((x) => x !== undefined).every((x) => typeof x === "number")).toBe(true);
  });

  test("the secret is read per call, not once: setting it later turns the door on", async () => {
    expect((await call({ "x-signals-cron": "later-secret" })).status).toBe(404);
    process.env.SIGNALS_CRON_SECRET = "later-secret";
    expect((await call({ "x-signals-cron": "later-secret" })).status).toBe(200);
  });
});
