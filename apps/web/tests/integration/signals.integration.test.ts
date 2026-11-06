import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearAgingCache } from "@/server/tl/aging";
import { clearAlertCache, getAlerts } from "@/server/tl/alerts";
import { acknowledgeSignal, clearSyncThrottle, getSignalSettings, listSignals, saveSignalSettings, signalCounts, syncSignals, syncSignalsIfStale } from "@/server/tl/signals";

/**
 * Stored signals in a workspace of their own: the alerts are kept as they appear, stay as they stay, resolve when they stop and reopen (with their history) when they return; a person limited to one
 * terminal reads and acknowledges only that terminal's; an acknowledged one that gets worse is open again; two desks never read each other's.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/signals.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sg-w";
const OTHER = "sg-other";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}
const fresh = () => {
  clearAlertCache();
  clearAgingCache();
};

describe.skipIf(!run)("stored signals", () => {
  const ids = { dOwed: "", mOwed: "", dDone: "", mDone: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "SG fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "SG other", plan: "enterprise" } });
    const truck = (name: string, terminal: string) => prisma.vehicle.create({ data: { workspaceId: W, name, terminal } });
    const dTruck = await truck("SG Dallas Truck", "Dallas");
    const mTruck = await truck("SG Memphis Truck", "Memphis");
    const mk = (n: string, v: { id: string }, extra: object) => prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: n, quotedRevenue: 1000, scheduledDate: days(-1), ...extra } });
    ids.dDone = (await mk("SG-D-DONE", dTruck, { status: "completed", actualRevenue: 1000, loadedMiles: 500, completedAt: days(2) })).id;
    ids.mDone = (await mk("SG-M-DONE", mTruck, { status: "completed", actualRevenue: 2000, loadedMiles: 500, completedAt: days(2) })).id;
    const owed = { status: "completed", actualRevenue: 500, loadedMiles: 200, completedAt: days(90), paymentStatus: "invoiced", invoicedAt: days(80), payTermsDays: 30, invoicedAmount: 500 };
    ids.dOwed = (await mk("SG-D-OWED", dTruck, owed)).id;
    ids.mOwed = (await mk("SG-M-OWED", mTruck, owed)).id;
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("the first sync keeps every alert the rules raise; syncing again at once changes nothing but last seen", async () => {
    fresh();
    const derived = (await getAlerts(NOW, W, "all")).alerts;
    expect(derived.length).toBeGreaterThanOrEqual(4);
    const first = await syncSignals(NOW, W);
    expect(first).toEqual({ created: derived.length, seen: 0, reopened: 0, resolved: 0, escalated: 0 });
    const again = await syncSignals(later(1), W);
    expect(again).toMatchObject({ created: 0, seen: derived.length, reopened: 0, resolved: 0 });
    const rows = await prisma.signal.findMany({ where: { workspaceId: W } });
    expect(rows).toHaveLength(derived.length);
    expect(rows.every((r) => r.status === "open" && r.firstSeenAt.getTime() === NOW.getTime() && r.lastSeenAt.getTime() === later(1).getTime())).toBe(true);
    expect(await prisma.signal.count({ where: { workspaceId: OTHER } })).toBe(0);
  });

  test("a signal whose alert stops is resolved and kept; when it returns it is reopened with its first-seen time and a count", async () => {
    const owedKey = (await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, loadId: ids.dOwed, code: "INVOICE_OVERDUE" } })).key;
    await prisma.load.update({ where: { id: ids.dOwed }, data: { paymentStatus: "paid" } });
    fresh();
    const out = await syncSignals(later(2), W);
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    const gone = await prisma.signal.findUniqueOrThrow({ where: { workspaceId_key: { workspaceId: W, key: owedKey } } });
    expect(gone).toMatchObject({ status: "resolved", reopenCount: 0 });
    expect(gone.resolvedAt?.getTime()).toBe(later(2).getTime());
    expect((await listSignals({ status: "resolved" }, null, W)).rows.map((r) => r.key)).toContain(owedKey);
    expect((await listSignals({ status: "open" }, null, W)).rows.map((r) => r.key)).not.toContain(owedKey);
    // Syncing again while it is still clear changes nothing about it.
    fresh();
    expect((await syncSignals(later(3), W)).resolved).toBe(0);

    await prisma.load.update({ where: { id: ids.dOwed }, data: { paymentStatus: "invoiced" } });
    fresh();
    const back = await syncSignals(later(4), W);
    expect(back.reopened).toBeGreaterThanOrEqual(1);
    const again = await prisma.signal.findUniqueOrThrow({ where: { workspaceId_key: { workspaceId: W, key: owedKey } } });
    expect(again).toMatchObject({ status: "open", reopenCount: 1, resolvedAt: null, lastLevelSent: null });
    expect(again.firstSeenAt.getTime()).toBe(NOW.getTime());
    // Still one row for it, not two.
    expect(await prisma.signal.count({ where: { workspaceId: W, key: owedKey } })).toBe(1);
  });

  test("a person limited to Dallas reads Dallas's signals only, and the counts follow the same scope", async () => {
    const all = await listSignals({ status: "open" }, null, W);
    const dallas = await listSignals({ status: "open" }, ["Dallas"], W);
    const memphis = await listSignals({ status: "open" }, ["Memphis"], W);
    expect(all.total).toBeGreaterThan(dallas.total);
    expect(dallas.total).toBeGreaterThan(0);
    expect(dallas.rows.every((r) => r.loadNumber?.startsWith("SG-D"))).toBe(true);
    expect(memphis.rows.every((r) => r.loadNumber?.startsWith("SG-M"))).toBe(true);
    expect(dallas.total + memphis.total).toBe(all.total);
    const counts = await signalCounts(["Dallas"], W);
    expect(counts.open).toBe(dallas.total);
    expect((await signalCounts(null, W)).open).toBe(all.total);
    // Worst first: no warn or info row comes before a block one.
    const order = all.rows.map((r) => ({ block: 0, warn: 1, info: 2 })[r.level]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("acknowledging: the person must be able to see it; it leaves the open list; a second try is told; it is audited with the load", async () => {
    const mem = await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, loadId: ids.mOwed, status: "open" } });
    const dal = await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, loadId: ids.dOwed, status: "open" } });
    // A Dallas-limited person guessing a Memphis signal's id gets the answer for one that does not exist.
    expect(await acknowledgeSignal(mem.id, NOW, W, ["Dallas"])).toEqual({ ok: false, error: "That signal is no longer on the desk." });
    expect((await prisma.signal.findUniqueOrThrow({ where: { id: mem.id } })).status).toBe("open");
    expect(await acknowledgeSignal("nope", NOW, W, null)).toEqual({ ok: false, error: "That signal is no longer on the desk." });

    expect(await acknowledgeSignal(dal.id, later(5), W, ["Dallas"])).toEqual({ ok: true });
    const kept = await prisma.signal.findUniqueOrThrow({ where: { id: dal.id } });
    expect(kept).toMatchObject({ status: "acknowledged", ackedBy: "Dispatcher" });
    expect(kept.ackedAt?.getTime()).toBe(later(5).getTime());
    expect((await listSignals({ status: "open" }, null, W)).rows.map((r) => r.id)).not.toContain(dal.id);
    expect((await listSignals({ status: "acknowledged" }, null, W)).rows.map((r) => r.id)).toContain(dal.id);
    expect(await acknowledgeSignal(dal.id, later(6), W, null)).toMatchObject({ ok: false, error: expect.stringMatching(/Already acknowledged by Dispatcher/) });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "signal_acknowledged" } });
    expect(audit).toMatchObject({ loadId: ids.dOwed, entity: "load" });
    // Acknowledged stays acknowledged while the alert is still raised.
    fresh();
    await syncSignals(later(7), W);
    expect((await prisma.signal.findUniqueOrThrow({ where: { id: dal.id } })).status).toBe("acknowledged");
  });

  test("an acknowledged signal that gets worse is open again, and one that clears and returns is open with the acknowledgement forgotten", async () => {
    const worse = await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, status: "open", level: { in: ["block", "warn"] }, loadId: ids.mDone } }).catch(() => null);
    const target = worse ?? (await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, status: "open", level: { in: ["block", "warn"] } } }));
    expect(await acknowledgeSignal(target.id, later(8), W, null)).toEqual({ ok: true });
    // Pretend it was only "info" when it was acknowledged, so the level the rules give now is an escalation.
    await prisma.signal.update({ where: { id: target.id }, data: { level: "info" } });
    fresh();
    const out = await syncSignals(later(9), W);
    expect(out.escalated).toBeGreaterThanOrEqual(1);
    const now = await prisma.signal.findUniqueOrThrow({ where: { id: target.id } });
    expect(now).toMatchObject({ status: "open", level: target.level, ackedBy: null, ackedAt: null });
  });

  test("two syncs at once make each signal once (the workspace lock and the unique key)", async () => {
    await prisma.signal.deleteMany({ where: { workspaceId: W } });
    fresh();
    const expected = (await getAlerts(later(10), W, "all")).alerts.length;
    const [a, b] = await Promise.all([syncSignals(later(10), W), syncSignals(later(10), W)]);
    expect(a.created + b.created).toBe(expected);
    expect(await prisma.signal.count({ where: { workspaceId: W } })).toBe(expected);
  });

  test("a page view syncs at most once a minute", async () => {
    clearSyncThrottle();
    fresh();
    expect(await syncSignalsIfStale(later(11), W)).not.toBeNull();
    expect(await syncSignalsIfStale(new Date(later(11).getTime() + 30_000), W)).toBeNull();
    expect(await syncSignalsIfStale(new Date(later(11).getTime() + 61_000), W)).not.toBeNull();
  });

  test("settings: defaults first, a saved choice wins and is audited, saving the same again writes nothing, a bad value names its field", async () => {
    expect(await getSignalSettings(W)).toEqual({ minLevel: "block", reportEnabled: true, reportDay: 1, reportHour: 7 });
    expect(await saveSignalSettings({ minLevel: "block", reportEnabled: "on", reportDay: "1", reportHour: "7" }, NOW, W)).toMatchObject({ ok: true, changed: false });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "signal_settings_changed" } })).toBe(0);
    expect(await saveSignalSettings({ minLevel: "warn", reportEnabled: "on", reportDay: "5", reportHour: "16" }, NOW, W)).toMatchObject({ ok: true, changed: true });
    expect(await getSignalSettings(W)).toEqual({ minLevel: "warn", reportEnabled: true, reportDay: 5, reportHour: 16 });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "signal_settings_changed" } });
    expect(audit.after).toMatchObject({ "Tell people about": "Block and warn", "Weekly report": "Friday at 4 PM" });
    expect(await saveSignalSettings({ minLevel: "warn", reportEnabled: "on", reportDay: "5", reportHour: "16" }, NOW, W)).toMatchObject({ ok: true, changed: false });
    expect(await saveSignalSettings({ minLevel: "loud", reportDay: "9" }, NOW, W)).toMatchObject({ ok: false, errors: { minLevel: expect.any(String), reportDay: expect.any(String) } });
    // Another desk has its own.
    expect(await getSignalSettings(OTHER)).toEqual({ minLevel: "block", reportEnabled: true, reportDay: 1, reportHour: 7 });
  });
});
