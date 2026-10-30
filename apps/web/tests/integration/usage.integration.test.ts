import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The desk's spend ledger against a real database (see tl-dispatch.integration.test.ts for the seed). It uses its own workspace ids and clears the ServiceUsage table around itself, so
 * the demo data is left as the seed wrote it. The ledger is switched ON here (the unit tests run with it off).
 */
const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("the spend ledger", () => {
  let claimUsage: typeof import("@/server/tl/usage").claimUsage;
  let releaseUsage: typeof import("@/server/tl/usage").releaseUsage;
  const WS = "usage-test-a";
  const WS2 = "usage-test-b";

  beforeAll(async () => {
    process.env.DESK_SPEND_METER = "on";
    delete process.env.DESK_SERVICES_OFF;
    ({ claimUsage, releaseUsage } = await import("@/server/tl/usage"));
  });
  beforeEach(async () => {
    await prisma.serviceUsage.deleteMany({});
  });
  afterAll(async () => {
    await prisma.serviceUsage.deleteMany({});
    process.env.DESK_SPEND_METER = "off";
  });

  test("a desk's own day: the claim after its limit is refused, and another desk is not affected", async () => {
    for (let i = 0; i < 3; i++) expect((await claimUsage("mapbox_geocode", { workspaceId: WS, limits: { workspaceDay: 3 } })).ok).toBe(true);
    expect(await claimUsage("mapbox_geocode", { workspaceId: WS, limits: { workspaceDay: 3 } })).toEqual({ ok: false, reason: "workspace_day" });
    expect((await claimUsage("mapbox_geocode", { workspaceId: WS2, limits: { workspaceDay: 3 } })).ok).toBe(true);
  });

  test("everyone's day and month, and the dollar ceiling", async () => {
    await claimUsage("anthropic_desk", { workspaceId: WS, limits: { globalDay: 2, globalMonthCents: 1000 } });
    await claimUsage("anthropic_desk", { workspaceId: WS2, limits: { globalDay: 2, globalMonthCents: 1000 } });
    expect(await claimUsage("anthropic_desk", { workspaceId: "usage-test-c", limits: { globalDay: 2, globalMonthCents: 1000 } })).toEqual({ ok: false, reason: "global_day" });
    await prisma.serviceUsage.deleteMany({});
    await claimUsage("anthropic_desk", { workspaceId: WS, limits: { globalDay: 100, globalMonthCents: 20 } }); // 8 cents
    await claimUsage("anthropic_desk", { workspaceId: WS, limits: { globalDay: 100, globalMonthCents: 20 } }); // 16
    expect(await claimUsage("anthropic_desk", { workspaceId: WS, limits: { globalDay: 100, globalMonthCents: 20 } })).toEqual({ ok: false, reason: "global_month_cents" }); // 24 > 20
  });

  test("a claim given back frees its place", async () => {
    const first = await claimUsage("mapbox_directions", { workspaceId: WS, limits: { workspaceDay: 1 } });
    expect(first.ok).toBe(true);
    expect((await claimUsage("mapbox_directions", { workspaceId: WS, limits: { workspaceDay: 1 } })).ok).toBe(false);
    await releaseUsage(first);
    expect((await claimUsage("mapbox_directions", { workspaceId: WS, limits: { workspaceDay: 1 } })).ok).toBe(true);
    await expect(releaseUsage({ ok: false, reason: "workspace_day" })).resolves.toBeUndefined();
    await expect(releaseUsage(null)).resolves.toBeUndefined();
  });

  test("twenty parallel claims at a limit of five make exactly five (the count-then-write it replaces passed all twenty)", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claimUsage("mapbox_permanent", { workspaceId: `usage-race-${i}`, limits: { globalDay: 5 } })));
    expect(results.filter((r) => r.ok).length).toBe(5);
    expect(await prisma.serviceUsage.count({ where: { service: "mapbox_permanent" } })).toBe(5);
  });

  test("the kill switch refuses without touching the ledger", async () => {
    process.env.DESK_SERVICES_OFF = "mapbox_geocode";
    try {
      expect(await claimUsage("mapbox_geocode", { workspaceId: WS })).toEqual({ ok: false, reason: "switched_off" });
      expect(await prisma.serviceUsage.count()).toBe(0);
      expect((await claimUsage("mapbox_directions", { workspaceId: WS })).ok).toBe(true); // only the named service
    } finally {
      delete process.env.DESK_SERVICES_OFF;
    }
  });

  test("a day later the desk's allowance is open again, and rows older than 70 days are cleared", async () => {
    const now = new Date("2026-10-31T12:00:00Z");
    await claimUsage("mapbox_geocode", { workspaceId: WS, now, limits: { workspaceDay: 1 } });
    expect((await claimUsage("mapbox_geocode", { workspaceId: WS, now, limits: { workspaceDay: 1 } })).ok).toBe(false);
    const tomorrow = new Date("2026-11-01T00:05:00Z");
    expect((await claimUsage("mapbox_geocode", { workspaceId: WS, now: tomorrow, limits: { workspaceDay: 1 } })).ok).toBe(true);
    await prisma.serviceUsage.create({ data: { workspaceId: WS, service: "mapbox_geocode", createdAt: new Date("2026-06-01T00:00:00Z") } });
    await claimUsage("mapbox_geocode", { workspaceId: WS2, now: tomorrow });
    expect(await prisma.serviceUsage.count({ where: { createdAt: { lt: new Date("2026-07-01T00:00:00Z") } } })).toBe(0);
  });

  test("a mapbox call over its allowance fails soft: no suggestions, no route, no throw", async () => {
    process.env.DESK_SERVICES_OFF = "all";
    process.env.MAPBOX_ACCESS_TOKEN = "test-token-never-sent";
    try {
      const mapbox = await import("@/server/geo/mapbox");
      expect(await mapbox.suggestPlaces("dallas")).toEqual([]);
      expect(await mapbox.geocode("Dallas, TX")).toBeNull();
      expect(await mapbox.geocodePermanent("Dallas, TX")).toBeNull();
      expect(await mapbox.drive([{ label: "a", lat: 32.7, lng: -96.8 }, { label: "b", lat: 33.7, lng: -97.8 }])).toBeNull();
    } finally {
      delete process.env.DESK_SERVICES_OFF;
      delete process.env.MAPBOX_ACCESS_TOKEN;
    }
  });
});
