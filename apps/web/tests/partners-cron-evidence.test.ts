import { afterEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The partner heartbeat freezes the detention evidence BEFORE it deletes the position fixes it is made from. The pieces are replaced here and the order they are called in is what is checked (the real
 * freeze and the real purge are in tests/integration/detention-evidence.integration.test.ts).
 */
const { calls, freezeMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const freezeMock = vi.fn(async () => (calls.push("freeze evidence"), { created: 3, improved: 1, unchanged: 0, noCoordinates: 0, noFixes: 0, loads: 2, failed: 0 }));
  return { calls, freezeMock };
});
vi.mock("@/server/partners/sync", () => ({ runPartnerSync: async () => (calls.push("sync"), { ran: 0, ok: 0, waiting: 0, failed: 0 }) }));
vi.mock("@/server/partners/credentials", () => ({ resealCredentials: async () => (calls.push("reseal"), 0) }));
vi.mock("@/server/partners/retention", () => ({
  purgeOldEvents: async () => (calls.push("purge events"), 0),
  purgeOldDeliveries: async () => (calls.push("purge deliveries"), 2),
  purgeOldPings: async () => (calls.push("purge pings"), 11),
  purgeOldStays: async () => (calls.push("purge stays"), 0)
}));
vi.mock("@/server/webhooks/deliver", () => ({ deliverDue: async () => (calls.push("deliver webhooks"), { claimed: 0, sent: 0, failed: 0, dead: 0, disabled: 0, skipped: 0 }) }));
vi.mock("@/server/partners/payroll", () => ({ pollPayrollStatus: async () => (calls.push("payroll"), null) }));
vi.mock("@/server/tl/detention-evidence", () => ({ freezeRecentDeliveries: freezeMock }));

import { POST } from "@/app/(public)/partners/cron/route";

afterEach(() => {
  delete process.env.PARTNER_CRON_SECRET;
  calls.length = 0;
  freezeMock.mockReset();
  freezeMock.mockImplementation(async () => (calls.push("freeze evidence"), { created: 3, improved: 1, unchanged: 0, noCoordinates: 0, noFixes: 0, loads: 2, failed: 0 }));
});

describe("the partner heartbeat and the detention evidence", () => {
  test("the evidence is frozen before the fixes are purged, and the answer says how many stops, as a count", async () => {
    process.env.PARTNER_CRON_SECRET = "s3cret-value";
    const res = await POST(new NextRequest("http://localhost:3102/partners/cron", { method: "POST", headers: { "x-partner-cron": "s3cret-value" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pingsPurged: 11, deliveriesPurged: 2, evidenceFrozen: 4, webhooks: { claimed: 0 } });
    expect(calls.indexOf("freeze evidence")).toBeGreaterThan(-1);
    expect(calls.indexOf("freeze evidence")).toBeLessThan(calls.indexOf("purge pings"));
  });

  test("holds off purging pings when freezeRecentDeliveries throws or reports any failed load", async () => {
    process.env.PARTNER_CRON_SECRET = "s3cret-value";
    freezeMock.mockRejectedValueOnce(new Error("db timeout"));
    const threw = await POST(new NextRequest("http://localhost:3102/partners/cron", { method: "POST", headers: { "x-partner-cron": "s3cret-value" } }));
    expect(threw.status).toBe(200);
    expect(await threw.json()).toMatchObject({ ok: true, pingsPurged: "held", freezeFailed: "error" });
    expect(calls).not.toContain("purge pings");

    calls.length = 0;
    freezeMock.mockImplementationOnce(async () => (calls.push("freeze evidence"), { created: 1, improved: 0, unchanged: 0, noCoordinates: 0, noFixes: 0, loads: 2, failed: 1 }));
    const partial = await POST(new NextRequest("http://localhost:3102/partners/cron", { method: "POST", headers: { "x-partner-cron": "s3cret-value" } }));
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ ok: true, pingsPurged: "held", freezeFailed: 1 });
    expect(calls).not.toContain("purge pings");
  });
});
