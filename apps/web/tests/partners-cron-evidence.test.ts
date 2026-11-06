import { afterEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The partner heartbeat freezes the detention evidence BEFORE it deletes the position fixes it is made from. The pieces are replaced here and the order they are called in is what is checked (the real
 * freeze and the real purge are in tests/integration/detention-evidence.integration.test.ts).
 */
const calls: string[] = [];
vi.mock("@/server/partners/sync", () => ({ runPartnerSync: async () => (calls.push("sync"), { ran: 0, ok: 0, waiting: 0, failed: 0 }) }));
vi.mock("@/server/partners/credentials", () => ({ resealCredentials: async () => (calls.push("reseal"), 0) }));
vi.mock("@/server/partners/retention", () => ({
  purgeOldEvents: async () => (calls.push("purge events"), 0),
  purgeOldPings: async () => (calls.push("purge pings"), 11),
  purgeOldStays: async () => (calls.push("purge stays"), 0)
}));
vi.mock("@/server/tl/detention-evidence", () => ({ freezeRecentDeliveries: async () => (calls.push("freeze evidence"), { created: 3, improved: 1, unchanged: 0, noCoordinates: 0, noFixes: 0, loads: 2, failed: 0 }) }));

import { POST } from "@/app/(public)/partners/cron/route";

afterEach(() => {
  delete process.env.PARTNER_CRON_SECRET;
  calls.length = 0;
});

describe("the partner heartbeat and the detention evidence", () => {
  test("the evidence is frozen before the fixes are purged, and the answer says how many stops, as a count", async () => {
    process.env.PARTNER_CRON_SECRET = "s3cret-value";
    const res = await POST(new NextRequest("http://localhost:3102/partners/cron", { method: "POST", headers: { "x-partner-cron": "s3cret-value" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pingsPurged: 11, evidenceFrozen: 4 });
    expect(calls.indexOf("freeze evidence")).toBeGreaterThan(-1);
    expect(calls.indexOf("freeze evidence")).toBeLessThan(calls.indexOf("purge pings"));
  });
});
