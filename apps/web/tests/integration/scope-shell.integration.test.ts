import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearAgingCache } from "@/server/tl/aging";
import { clearAlertCache, getAlerts, getAlertsInTerminal } from "@/server/tl/alerts";
import { clearFinishedTotals } from "@/server/tl/finished-totals";
import { getConversation, listThreads, markThreadRead, sendMessage, startableDrivers, unreadMessageCount } from "@/server/tl/messages";
import { getShellData } from "@/server/tl/shell";

/**
 * The header's numbers, the alerts and the messages for one slice of the fleet: a person limited to Dallas never sees Memphis's open loads, drivers waiting, invoices overdue, gross, alerts, conversations
 * or unread messages in the header, and cannot open, read, mark or write to a Memphis driver by id.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/scope-shell.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ss-w";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("the header, alerts and messages follow the scope", () => {
  const ids = { dDriver: "", mDriver: "", dLoadDraft: "", mLoadDraft: "", dDone: "", mDone: "", open: "" };
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "SS fleet", plan: "enterprise" } });
    const truck = (name: string, terminal: string) => prisma.vehicle.create({ data: { workspaceId: W, name, terminal } });
    const dTruck = await truck("SS Dallas Truck", "Dallas");
    const mTruck = await truck("SS Memphis Truck", "Memphis");
    ids.dDriver = (await prisma.driver.create({ data: { workspaceId: W, name: "SS Dallas Driver", code: "DALA", terminal: "Dallas" } })).id;
    ids.mDriver = (await prisma.driver.create({ data: { workspaceId: W, name: "SS Memphis Driver", code: "MEMP", terminal: "Memphis" } })).id;
    const mk = (n: string, v: { id: string } | null, extra: object) => prisma.load.create({ data: { workspaceId: W, vehicleId: v?.id ?? null, loadNumber: n, quotedRevenue: 1000, scheduledDate: days(-1), ...extra } });
    ids.dLoadDraft = (await mk("SS-D-DRAFT", dTruck, { status: "draft" })).id;
    ids.mLoadDraft = (await mk("SS-M-DRAFT", mTruck, { status: "draft" })).id;
    await mk("SS-D-ROAD", dTruck, { status: "in_progress" });
    await mk("SS-M-ROAD", mTruck, { status: "in_progress" });
    ids.dDone = (await mk("SS-D-DONE", dTruck, { status: "completed", actualRevenue: 1000, loadedMiles: 500, completedAt: days(2) })).id;
    ids.mDone = (await mk("SS-M-DONE", mTruck, { status: "completed", actualRevenue: 2000, loadedMiles: 500, completedAt: days(2) })).id;
    // One invoice each, long overdue.
    await mk("SS-D-OWED", dTruck, { status: "completed", actualRevenue: 500, loadedMiles: 200, completedAt: days(90), paymentStatus: "invoiced", invoicedAt: days(80), payTermsDays: 30, invoicedAmount: 500 });
    await mk("SS-M-OWED", mTruck, { status: "completed", actualRevenue: 500, loadedMiles: 200, completedAt: days(90), paymentStatus: "invoiced", invoicedAt: days(80), payTermsDays: 30, invoicedAmount: 500 });
    // A booking with no truck yet: everyone who can assign it sees it.
    ids.open = (await mk("SS-OPEN", null, { status: "draft" })).id;
    // A driver wrote in from each terminal.
    for (const [driverId, body] of [[ids.dDriver, "Dallas here"], [ids.mDriver, "Memphis here"]] as const) {
      const t = await prisma.thread.create({ data: { workspaceId: W, driverId } });
      await prisma.message.create({ data: { threadId: t.id, direction: "in", body, sentAt: NOW } });
      await prisma.thread.update({ where: { id: t.id }, data: { lastMessageAt: NOW } });
    }
  });
  afterAll(async () => {
    await wipe(W);
  });

  const limited = (names: string[]): Parameters<typeof getShellData>[1] => ({ choice: { kind: "all" }, limit: { kind: "some", regionIds: [], terminals: names } });

  test("the header's counts are the person's terminals' (and the unplaced booking), never the whole fleet's", async () => {
    clearAgingCache();
    clearAlertCache();
    clearFinishedTotals();
    const dallas = await getShellData(W, limited(["Dallas"]));
    const all = await getShellData(W);
    expect(dallas.scope).toMatchObject({ names: ["Dallas"], limited: true });
    // Needs a driver: Dallas's draft and the unplaced booking; everyone's adds Memphis's.
    expect(dallas.counts.needsDriver).toBe(2);
    expect(all.counts.needsDriver).toBe(3);
    expect(dallas.counts.onTheRoad).toBe(1);
    expect(all.counts.onTheRoad).toBe(2);
    expect(dallas.counts.readyToInvoice).toBe(1);
    expect(all.counts.readyToInvoice).toBe(2);
    expect(dallas.counts.overdue).toBe(1);
    expect(all.counts.overdue).toBe(2);
    expect(dallas.totals.open).toBe(3); // draft, on the road, and the unplaced booking
    expect(all.totals.open).toBe(5);
    expect(dallas.totals.gross).toBe(1500); // 1000 + 500 on Dallas's finished loads
    expect(all.totals.gross).toBe(4000);
    expect(dallas.counts.unreadMessages).toBe(1);
    expect(all.counts.unreadMessages).toBe(2);
  });

  test("alerts: the scope is part of the read, and part of the kept answer", async () => {
    clearAlertCache();
    const dallas = await getAlertsInTerminal(["Dallas"], NOW, W);
    const memphis = await getAlertsInTerminal(["Memphis"], NOW, W);
    const everything = await getAlerts(NOW, W, "all");
    const ofLoad = async (a: { loadId: string }[]) => (await prisma.load.findMany({ where: { id: { in: a.map((x) => x.loadId) } }, select: { loadNumber: true } })).map((l) => l.loadNumber ?? "").sort();
    const d = await ofLoad(dallas.alerts);
    const m = await ofLoad(memphis.alerts);
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((n) => n.startsWith("SS-D") || n === "SS-OPEN")).toBe(true);
    expect(m.every((n) => n.startsWith("SS-M") || n === "SS-OPEN")).toBe(true);
    expect(everything.alerts.length).toBeGreaterThan(dallas.alerts.length);
    // Asked again for Dallas after Memphis: still Dallas's.
    expect(await ofLoad((await getAlertsInTerminal(["Dallas"], NOW, W)).alerts)).toEqual(d);
  });

  test("messages: conversations, unread counts and who to start with are the terminals' drivers", async () => {
    expect((await listThreads(W, ["Dallas"])).map((t) => t.driverName)).toEqual(["SS Dallas Driver"]);
    expect((await listThreads(W, null)).map((t) => t.driverName).sort()).toEqual(["SS Dallas Driver", "SS Memphis Driver"]);
    expect(await unreadMessageCount(W, ["Dallas"])).toBe(1);
    expect(await unreadMessageCount(W, null)).toBe(2);
    expect((await startableDrivers(W, ["Dallas"])).map((d) => d.name)).toEqual([]); // both have threads already
    await prisma.driver.create({ data: { workspaceId: W, name: "SS New Dallas", code: "NEWD", terminal: "Dallas" } });
    await prisma.driver.create({ data: { workspaceId: W, name: "SS New Memphis", code: "NEWM", terminal: "Memphis" } });
    expect((await startableDrivers(W, ["Dallas"])).map((d) => d.name)).toEqual(["SS New Dallas"]);
    expect((await startableDrivers(W, null, "newm")).map((d) => d.name)).toEqual(["SS New Memphis"]); // a search by code
    expect((await startableDrivers(W, ["Dallas"], "newm")).map((d) => d.name)).toEqual([]);
  });

  test("messages: a driver outside the limit is not found, cannot be written to, and nothing of theirs is marked read", async () => {
    expect(await getConversation(ids.mDriver, W, ["Dallas"])).toBeNull();
    expect((await getConversation(ids.dDriver, W, ["Dallas"]))!.driver.name).toBe("SS Dallas Driver");
    expect(await getConversation(ids.mDriver, W, null)).not.toBeNull();
    expect(await sendMessage({ driverId: ids.mDriver, body: "hello", allowed: ["Dallas"] }, W)).toEqual({ ok: false, error: "That driver is not on this desk." });
    expect(await prisma.message.count({ where: { direction: "out", thread: { workspaceId: W } } })).toBe(0);
    expect(await markThreadRead(ids.mDriver, W, ["Dallas"])).toBe(0);
    expect(await unreadMessageCount(W, ["Memphis"])).toBe(1); // still unread
    expect(await sendMessage({ driverId: ids.dDriver, body: "hello", allowed: ["Dallas"] }, W)).toMatchObject({ ok: true });
    expect(await markThreadRead(ids.dDriver, W, ["Dallas"])).toBe(1);
  });
});
