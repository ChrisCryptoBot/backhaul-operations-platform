import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { RATE_CON_FAILED_READS_PER_DAY, burstReadsPerDay, hardMonthlyReads, includedReads } from "@/lib/plans";

/**
 * A workspace holds only what its plan holds: the trucks of the plan, and twice as many drivers and trailers, and one with no plan chosen is held to Starter. Every path that makes
 * a unit or brings one back is tried at the limit: adding, importing, restoring, reactivating, and two adds at once. Runs in a workspace of its own, which the seam is made to name.
 */
const W = "plan-limits";
vi.mock("@/server/tl/workspace", async (original) => {
  const real = await original<typeof import("@/server/tl/workspace")>();
  const { prisma: db } = await import("@/lib/db");
  return { ...real, currentWorkspaceId: () => "plan-limits", currentWorkspace: () => db.workspace.findUniqueOrThrow({ where: { id: "plan-limits" } }) };
});

const run = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!run)("plan limits", () => {
  const setPlan = (plan: string | null) => prisma.workspace.update({ where: { id: W }, data: { plan } });
  const clear = async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.messageAttachment.deleteMany({ where: { message: { thread: { workspaceId: W } } } });
    await prisma.message.deleteMany({ where: { thread: { workspaceId: W } } });
    await prisma.thread.deleteMany({ where: { workspaceId: W } });
    await prisma.trailer.deleteMany({ where: { workspaceId: W } });
    await prisma.driver.deleteMany({ where: { workspaceId: W } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: W } });
  };

  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Plan limits", plan: "starter" } });
  });
  beforeEach(async () => {
    await clear();
    await setPlan("starter");
  });
  afterAll(async () => {
    await clear();
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`);
  const file = (header: string, rows: string[]) => [header, ...rows].join("\n");

  const seedTrucks = (n: number, p: string) => prisma.vehicle.createMany({ data: names(n, p).map((name) => ({ workspaceId: W, name })) });
  const seedDrivers = (n: number, p: string) => prisma.driver.createMany({ data: names(n, p).map((name) => ({ workspaceId: W, name })) });
  const seedTrailers = (n: number, p: string) => prisma.trailer.createMany({ data: names(n, p).map((number) => ({ workspaceId: W, number })) });

  test("trucks: ten on Starter, the eleventh is refused with the plan named", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    for (const n of names(10, "T")) expect(await saveTruck({ name: n }, null)).toMatchObject({ ok: true });
    expect(await saveTruck({ name: "T 11" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 10 trucks") });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(10);
  });

  test("a workspace with no plan chosen is held to Starter, not to no limit", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    await setPlan(null);
    await seedTrucks(10, "N");
    expect(await saveTruck({ name: "N 11" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 10 trucks") });
  });

  test("archive one, add another, restore the first: the restore is refused (it would be the eleventh)", async () => {
    const { saveTruck, setTruckArchived } = await import("@/server/tl/fleet");
    const a = await saveTruck({ name: "R 1" }, null);
    await seedTrucks(9, "R+");
    if (!a.ok) throw new Error("setup");
    expect(await setTruckArchived(a.id, true)).toEqual({ ok: true });
    expect(await saveTruck({ name: "R 11" }, null)).toMatchObject({ ok: true });
    expect(await setTruckArchived(a.id, false)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 10 trucks") });
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: a.id } })).archivedAt).not.toBeNull();
  });

  test("drivers: twenty on Starter (twice its trucks), the twenty-first is refused; bringing one back past the limit is too", async () => {
    const { saveDriver, setDriverActive } = await import("@/server/tl/fleet");
    const first = await saveDriver({ name: "D 1" }, null);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error("setup");
    await seedDrivers(19, "D+");
    expect(await saveDriver({ name: "D 21" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 20 drivers (twice its 10 trucks)") });
    expect(await setDriverActive(first.id, false)).toEqual({ ok: true });
    expect(await saveDriver({ name: "D 21" }, null)).toMatchObject({ ok: true });
    expect(await setDriverActive(first.id, true)).toMatchObject({ ok: false, error: expect.stringContaining("20 drivers") });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: first.id } })).active).toBe(false);
  });

  test("trailers: twenty on Starter, the twenty-first is refused; restoring one past the limit is too", async () => {
    const { saveTrailer, setTrailerArchived } = await import("@/server/tl/trailers");
    const first = await saveTrailer({ number: "TR 1" }, null);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error("setup");
    await seedTrailers(19, "TR+");
    expect(await saveTrailer({ number: "TR 21" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 20 trailers") });
    expect(await setTrailerArchived(first.id, true)).toEqual({ ok: true });
    expect(await saveTrailer({ number: "TR 21" }, null)).toMatchObject({ ok: true });
    expect(await setTrailerArchived(first.id, false)).toMatchObject({ ok: false, error: expect.stringContaining("20 trailers") });
  });

  test("an import that would pass the limit is refused whole, for trucks, drivers and trailers, and says so in the preview", async () => {
    const { commitImport, previewImport } = await import("@/server/tl/import");
    const trucks = file("Name", names(12, "I"));
    const preview = await previewImport("trucks", trucks, W);
    expect(preview).toMatchObject({ ok: true, ready: 12, room: { used: 0, limit: 10, over: true, message: expect.stringContaining("Starter plan covers 10 trucks") } });
    expect(await commitImport("trucks", trucks, "t.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("This file has 12 to add") });
    expect(await commitImport("drivers", file("Name", names(21, "ID")), "d.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("20 drivers") });
    expect(await commitImport("trailers", file("Number", names(21, "IT")), "tr.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("20 trailers") });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(0);
    expect(await prisma.driver.count({ where: { workspaceId: W } })).toBe(0);
    expect(await prisma.trailer.count({ where: { workspaceId: W } })).toBe(0);
    // what fits goes in
    expect(await commitImport("trucks", file("Name", names(10, "OK")), "ok.csv", new Date(), W)).toMatchObject({ ok: true, created: 10 });
    expect(await previewImport("trucks", file("Name", ["More 1"]), W)).toMatchObject({ ok: true, room: { used: 10, limit: 10, over: true } });
  });

  test("two adds at once at the edge of the limit: exactly one gets in", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    await seedTrucks(9, "C");
    const both = await Promise.all([saveTruck({ name: "Race A" }, null), saveTruck({ name: "Race B" }, null)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(10);
  });

  test("a larger plan holds more: Growth takes the eleventh truck and 50 drivers; Enterprise has no automatic limit", async () => {
    const { saveTruck, saveDriver } = await import("@/server/tl/fleet");
    await setPlan("growth");
    await seedTrucks(10, "G");
    expect(await saveTruck({ name: "G 11" }, null)).toMatchObject({ ok: true });
    await seedDrivers(49, "GD");
    expect(await saveDriver({ name: "GD 50" }, null)).toMatchObject({ ok: true });
    expect(await saveDriver({ name: "GD 51" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Growth plan covers 50 drivers") });
    await setPlan("enterprise");
    await prisma.vehicle.createMany({ data: names(60, "E").map((name) => ({ workspaceId: W, name })) });
    expect(await saveTruck({ name: "E 61" }, null)).toMatchObject({ ok: true });
    expect(await saveDriver({ name: "GD 51" }, null)).toMatchObject({ ok: true });
  });

  test("the plan summary and the Add buttons read what is used of each limit, and the price shows its minimum", async () => {
    const { planSummary, unitUse } = await import("@/server/tl/plan");
    const { saveTruck } = await import("@/server/tl/fleet");
    for (const n of names(3, "S")) await saveTruck({ name: n }, null);
    expect(await unitUse("truck")).toMatchObject({ used: 3, limit: 10, full: false });
    expect(await unitUse("driver")).toMatchObject({ used: 0, limit: 20, full: false });
    const s = await planSummary(W);
    expect(s.units.map((u) => [u.kind, u.used, u.limit])).toEqual([["truck", 3, 10], ["driver", 0, 20], ["trailer", 0, 20], ["member", 0, 3]]);
    expect(s).toMatchObject({ price: "$99 + $25 a truck, $349 minimum", monthly: "$349", parts: "$99 + 3 × $25, minimum $349" });
    await seedTrucks(7, "S+");
    expect(await planSummary(W)).toMatchObject({ monthly: "$349", parts: "$99 + 10 × $25" });
    await setPlan(null);
    expect(await planSummary(W)).toMatchObject({ key: "starter", chosen: false });
  });

  test("rate confirmation reads: a small desk's burst limit is 25 a day, or 10 that failed; a day later it is open again", async () => {
    const { readMeter, noteRead } = await import("@/server/ratecon/meter");
    const now = new Date();
    const perDay = burstReadsPerDay(0); // no trucks yet: one truck's allowance, the 25 a day minimum
    expect(perDay).toBe(25);
    expect(await readMeter(now, W)).toEqual({ ok: true });
    for (let i = 0; i < perDay - 1; i++) await noteRead(true, `rc-${i}.pdf`, now, W);
    expect(await readMeter(now, W)).toEqual({ ok: true });
    await noteRead(true, "rc-last.pdf", now, W);
    expect(await readMeter(now, W)).toEqual({ ok: false, reason: "daily_limit" });
    expect(await readMeter(new Date(now.getTime() + 25 * 3_600_000), W)).toEqual({ ok: true });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    for (let i = 0; i < RATE_CON_FAILED_READS_PER_DAY; i++) await noteRead(false, `bad-${i}.pdf`, now, W);
    expect(await readMeter(now, W)).toEqual({ ok: false, reason: "daily_limit" });
  });

  test("rate confirmation reads: the month's hard limit is the allowance plus the overage ceiling; reads that failed are not counted or billed", async () => {
    const { readMeter, noteRead, readUsageSummary } = await import("@/server/ratecon/meter");
    const base = new Date(Date.UTC(2026, 5, 10, 12)); // 10 June; the checks below are made three days later, so no read is in the daily window
    const later = new Date(Date.UTC(2026, 5, 13, 12));
    const hard = hardMonthlyReads(0); // 25 included + 200 the $50 ceiling pays for
    expect(hard).toBe(225);
    for (let i = 0; i < includedReads(0) + 5; i++) await noteRead(true, `m-${i}.pdf`, base, W);
    for (let i = 0; i < 3; i++) await noteRead(false, `badm-${i}.pdf`, base, W);
    expect(await readUsageSummary(later, W)).toEqual({ trucks: 0, included: 25, worked: 30, over: 5, overageCents: 125, ceilingCents: 5000, atCeiling: false });
    expect(await readMeter(later, W)).toEqual({ ok: true });
    for (let i = 0; i < hard - 30; i++) await noteRead(true, `n-${i}.pdf`, base, W);
    expect(await readUsageSummary(later, W)).toMatchObject({ worked: 225, over: 200, overageCents: 5000, atCeiling: true });
    expect(await readMeter(later, W)).toEqual({ ok: false, reason: "month_limit" });
    expect(await readMeter(new Date(Date.UTC(2026, 6, 1, 12)), W)).toEqual({ ok: true }); // a new month, a new allowance
  });

  test("message attachments: a desk past its plan's storage is refused before anything is kept", async () => {
    const { sendMessage } = await import("@/server/tl/messages");
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Msg Driver" } });
    const thread = await prisma.thread.create({ data: { workspaceId: W, driverId: driver.id } });
    const message = await prisma.message.create({ data: { threadId: thread.id, direction: "out", body: "old", sentAt: new Date() } });
    await prisma.messageAttachment.create({ data: { messageId: message.id, kind: "file", name: "big.pdf", mime: "application/pdf", bytes: 249 * 1024 * 1024, sha256: "0".repeat(64), storageKey: "none" } });
    const out = await sendMessage({ driverId: driver.id, body: "more", files: [{ ok: true, type: { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" }, data: new Uint8Array(2 * 1024 * 1024), name: "new.pdf" }] }, W);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("holds 250 MB") });
    expect(await prisma.messageAttachment.count({ where: { message: { thread: { workspaceId: W } } } })).toBe(1);
  });
});
