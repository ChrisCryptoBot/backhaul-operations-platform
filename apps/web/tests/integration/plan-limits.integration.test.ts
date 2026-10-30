import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { RATE_CON_FAILED_READS_PER_DAY, rateConReadsPerDay } from "@/lib/plans";

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

  test("trucks: three on Starter, the fourth is refused with the plan named", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    for (const n of names(3, "T")) expect(await saveTruck({ name: n }, null)).toMatchObject({ ok: true });
    expect(await saveTruck({ name: "T 4" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 3 trucks") });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(3);
  });

  test("a workspace with no plan chosen is held to Starter, not to no limit", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    await setPlan(null);
    for (const n of names(3, "N")) await saveTruck({ name: n }, null);
    expect(await saveTruck({ name: "N 4" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 3 trucks") });
  });

  test("archive one, add another, restore the first: the restore is refused (it would be the fourth)", async () => {
    const { saveTruck, setTruckArchived } = await import("@/server/tl/fleet");
    const a = await saveTruck({ name: "R 1" }, null);
    await saveTruck({ name: "R 2" }, null);
    await saveTruck({ name: "R 3" }, null);
    if (!a.ok) throw new Error("setup");
    expect(await setTruckArchived(a.id, true)).toEqual({ ok: true });
    expect(await saveTruck({ name: "R 4" }, null)).toMatchObject({ ok: true });
    expect(await setTruckArchived(a.id, false)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 3 trucks") });
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: a.id } })).archivedAt).not.toBeNull();
  });

  test("drivers: six on Starter (twice its trucks), the seventh is refused; bringing one back past the limit is too", async () => {
    const { saveDriver, setDriverActive } = await import("@/server/tl/fleet");
    const ids: string[] = [];
    for (const n of names(6, "D")) {
      const out = await saveDriver({ name: n }, null);
      expect(out).toMatchObject({ ok: true });
      if (out.ok) ids.push(out.id);
    }
    expect(await saveDriver({ name: "D 7" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 6 drivers (twice its 3 trucks)") });
    expect(await setDriverActive(ids[0]!, false)).toEqual({ ok: true });
    expect(await saveDriver({ name: "D 7" }, null)).toMatchObject({ ok: true });
    expect(await setDriverActive(ids[0]!, true)).toMatchObject({ ok: false, error: expect.stringContaining("6 drivers") });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: ids[0]! } })).active).toBe(false);
  });

  test("trailers: six on Starter, the seventh is refused; restoring one past the limit is too", async () => {
    const { saveTrailer, setTrailerArchived } = await import("@/server/tl/trailers");
    const ids: string[] = [];
    for (const n of names(6, "TR")) {
      const out = await saveTrailer({ number: n }, null);
      expect(out).toMatchObject({ ok: true });
      if (out.ok) ids.push(out.id);
    }
    expect(await saveTrailer({ number: "TR 7" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 6 trailers") });
    expect(await setTrailerArchived(ids[0]!, true)).toEqual({ ok: true });
    expect(await saveTrailer({ number: "TR 7" }, null)).toMatchObject({ ok: true });
    expect(await setTrailerArchived(ids[0]!, false)).toMatchObject({ ok: false, error: expect.stringContaining("6 trailers") });
  });

  test("an import that would pass the limit is refused whole, for trucks, drivers and trailers, and says so in the preview", async () => {
    const { commitImport, previewImport } = await import("@/server/tl/import");
    const trucks = file("Name", names(5, "I"));
    const preview = await previewImport("trucks", trucks, W);
    expect(preview).toMatchObject({ ok: true, ready: 5, room: { used: 0, limit: 3, over: true, message: expect.stringContaining("Starter plan covers 3 trucks") } });
    expect(await commitImport("trucks", trucks, "t.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("This file has 5 to add") });
    expect(await commitImport("drivers", file("Name", names(7, "ID")), "d.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("6 drivers") });
    expect(await commitImport("trailers", file("Number", names(7, "IT")), "tr.csv", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("6 trailers") });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(0);
    expect(await prisma.driver.count({ where: { workspaceId: W } })).toBe(0);
    expect(await prisma.trailer.count({ where: { workspaceId: W } })).toBe(0);
    // what fits goes in
    expect(await commitImport("trucks", file("Name", names(3, "OK")), "ok.csv", new Date(), W)).toMatchObject({ ok: true, created: 3 });
    expect(await previewImport("trucks", file("Name", ["More 1"]), W)).toMatchObject({ ok: true, room: { used: 3, limit: 3, over: true } });
  });

  test("two adds at once at the edge of the limit: exactly one gets in", async () => {
    const { saveTruck } = await import("@/server/tl/fleet");
    for (const n of names(2, "C")) await saveTruck({ name: n }, null);
    const both = await Promise.all([saveTruck({ name: "Race A" }, null), saveTruck({ name: "Race B" }, null)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(3);
  });

  test("a larger plan holds more: Growth takes the fourth truck and 20 drivers; Enterprise has no automatic limit", async () => {
    const { saveTruck, saveDriver } = await import("@/server/tl/fleet");
    await setPlan("growth");
    for (const n of names(4, "G")) expect(await saveTruck({ name: n }, null)).toMatchObject({ ok: true });
    await prisma.driver.createMany({ data: names(19, "GD").map((name) => ({ workspaceId: W, name })) });
    expect(await saveDriver({ name: "GD 20" }, null)).toMatchObject({ ok: true });
    expect(await saveDriver({ name: "GD 21" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Growth plan covers 20 drivers") });
    await setPlan("enterprise");
    await prisma.vehicle.createMany({ data: names(60, "E").map((name) => ({ workspaceId: W, name })) });
    expect(await saveTruck({ name: "E 61" }, null)).toMatchObject({ ok: true });
    expect(await saveDriver({ name: "GD 21" }, null)).toMatchObject({ ok: true });
  });

  test("the plan summary and the Add buttons read what is used of each limit", async () => {
    const { planSummary, unitUse } = await import("@/server/tl/plan");
    const { saveTruck } = await import("@/server/tl/fleet");
    for (const n of names(3, "S")) await saveTruck({ name: n }, null);
    expect(await unitUse("truck")).toMatchObject({ used: 3, limit: 3, full: true });
    expect(await unitUse("driver")).toMatchObject({ used: 0, limit: 6, full: false });
    const s = await planSummary(W);
    expect(s.units.map((u) => [u.kind, u.used, u.limit])).toEqual([["truck", 3, 3], ["driver", 0, 6], ["trailer", 0, 6], ["member", 0, 1]]);
    await setPlan(null);
    expect(await planSummary(W)).toMatchObject({ key: "starter", chosen: false });
  });

  test("rate confirmation reads: the daily meter stops at the plan's reads (Starter 10), or at 10 that failed; a day later it is open again", async () => {
    const { readMeter, noteRead } = await import("@/server/ratecon/meter");
    const now = new Date();
    const perDay = rateConReadsPerDay(null); // no plan chosen: Starter
    expect(perDay).toBe(10);
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
