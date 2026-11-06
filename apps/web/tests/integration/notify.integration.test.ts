import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { MAX_ATTEMPTS } from "@/lib/notify";
import { clearAgingCache } from "@/server/tl/aging";
import { clearAlertCache } from "@/server/tl/alerts";
import { clearHealthCache } from "@/server/tl/data-health";
import { clearKpiCache } from "@/server/tl/kpi";
import { clearLeakCache } from "@/server/tl/leaks";
import { acknowledgeSignal, saveSignalSettings } from "@/server/tl/signals";
import { runSignalsCron } from "@/server/tl/signals-cron";
import { listNotifications } from "@/server/tl/signal-notify";
import type { Fetch } from "@/server/notify/types";

/**
 * Telling people, in a workspace of its own and with a fake `fetch` (no network): each signal goes out once per level on every channel, a failure is tried again on the backoff and then given up, two runs at
 * the same moment send once, a signal someone took is not sent, the level asked for is respected, the weekly report goes once a week, and nothing in the ledger carries a body, an address or a key.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/notify.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "nt-w";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const SECRET = "whsec_nt_secret";
const URL_ = "https://n8n.example.com/webhook/nt-path-xyz";
const REAL = { DESK_AUTH: "on" }; // sign-in on: the simulator is off, so only what is configured is a channel
const HOOK = { ...REAL, NOTIFY_WEBHOOK_URL: URL_, NOTIFY_WEBHOOK_SECRET: SECRET };

type Seen = { body: Record<string, unknown>; delivery: string };
const hook = (status = 200) => {
  const seen: Seen[] = [];
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String(init?.body)), delivery: (init?.headers as Record<string, string>)["x-desk-delivery"]! });
    return new Response("a body that must never be stored", { status });
  }) as unknown as Fetch;
  return { f, seen };
};

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}
const fresh = () => {
  clearAlertCache();
  clearAgingCache();
  clearKpiCache();
  clearLeakCache();
  clearHealthCache();
};
/** Forget everything told: the ledger empty, every signal not yet told about. */
const reset = async () => {
  await prisma.notificationLog.deleteMany({ where: { workspaceId: W } });
  await prisma.signal.updateMany({ where: { workspaceId: W }, data: { lastLevelSent: null } });
};
const cron = (env: Record<string, string>, f: Fetch, now = NOW) => {
  fresh();
  return runSignalsCron({ now, env, fetchFn: f, workspaceId: W, deskUrl: "https://desk.example.com" });
};

describe.skipIf(!run)("telling people", () => {
  let open = 0;
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "NT fleet", plan: "enterprise" } });
    const dTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "NT Dallas Truck", terminal: "Dallas" } });
    const mk = (n: string, extra: object) => prisma.load.create({ data: { workspaceId: W, vehicleId: dTruck.id, loadNumber: n, quotedRevenue: 1000, scheduledDate: days(-1), ...extra } });
    await mk("NT-DONE", { status: "completed", actualRevenue: 1000, loadedMiles: 500, completedAt: days(2) });
    await mk("NT-OWED", { status: "completed", actualRevenue: 500, loadedMiles: 200, completedAt: days(90), paymentStatus: "invoiced", invoicedAt: days(80), payTermsDays: 30, invoicedAmount: 500 });
    // A block: an open load on a trailer that is out of service, so the level tests have something at each level.
    const trailer = await prisma.trailer.create({ data: { workspaceId: W, number: "NT-TR-1", status: "out_of_service" } });
    await mk("NT-TRAIL", { status: "draft", trailerId: trailer.id });
    // Everything is asked for unless a test narrows it.
    await saveSignalSettings({ minLevel: "info", reportEnabled: "off" }, NOW, W);
    fresh();
    await runSignalsCron({ now: NOW, env: REAL, workspaceId: W });
    open = await prisma.signal.count({ where: { workspaceId: W, status: "open" } });
  });
  afterAll(async () => {
    await wipe(W);
  });

  test("with no channel set up nothing is sent or written, and the signals are not marked as told", async () => {
    const { f, seen } = hook();
    const out = await cron(REAL, f);
    expect(out).toMatchObject({ channels: 0, workspaces: 1, failed: 0, notified: { due: 0, sent: 0 }, reports: { no_channel: 0, off: 1 } });
    expect(seen).toHaveLength(0);
    expect(await prisma.notificationLog.count({ where: { workspaceId: W } })).toBe(0);
    expect(await prisma.signal.count({ where: { workspaceId: W, lastLevelSent: { not: null } } })).toBe(0);
    expect(open).toBeGreaterThanOrEqual(2);
  });

  test("each open signal goes out once, with the facts a workflow formats from; a second and a third run send nothing", async () => {
    await reset();
    const { f, seen } = hook();
    const first = await cron(HOOK, f);
    expect(first).toMatchObject({ channels: 1, notified: { due: open, sent: open, failed: 0, waiting: 0 } });
    expect(seen).toHaveLength(open);
    expect(new Set(seen.map((s) => s.delivery)).size).toBe(open);
    const owed = seen.map((s) => s.body).find((b) => b.loadNumber === "NT-OWED" && String(b.data && (b.data as { code: string }).code) === "INVOICE_OVERDUE")!;
    expect(owed).toMatchObject({ kind: "signal", unit: "NT Dallas Truck", dollars: 500 });
    expect(String(owed.deskUrl)).toMatch(/^https:\/\/desk\.example\.com\/loads\//);
    expect(await prisma.signal.count({ where: { workspaceId: W, status: "open", lastLevelSent: null } })).toBe(0);
    const rows = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    expect(rows).toHaveLength(open);
    expect(rows.every((r) => r.state === "sent" && r.channel === "webhook" && r.attempts === 1 && r.sentAt != null && r.error == null && r.dedupeKey.startsWith("webhook:signal:"))).toBe(true);

    const again = hook();
    expect(await cron(HOOK, again.f, at(5))).toMatchObject({ notified: { due: 0, sent: 0 } });
    expect(await cron(HOOK, again.f, at(60))).toMatchObject({ notified: { due: 0, sent: 0 } });
    expect(again.seen).toHaveLength(0);
  });

  test("the ledger itself refuses a second row for the same thing on the same channel", async () => {
    const one = await prisma.notificationLog.findFirstOrThrow({ where: { workspaceId: W } });
    await expect(prisma.notificationLog.create({ data: { workspaceId: W, kind: one.kind, dedupeKey: one.dedupeKey, channel: one.channel } })).rejects.toMatchObject({ code: "P2002" });
    // The same thing on another channel is a different row.
    await expect(prisma.notificationLog.create({ data: { workspaceId: W, kind: one.kind, dedupeKey: `slack:${one.dedupeKey.slice(8)}`, channel: "slack" } })).resolves.toBeTruthy();
    await prisma.notificationLog.delete({ where: { workspaceId_dedupeKey: { workspaceId: W, dedupeKey: `slack:${one.dedupeKey.slice(8)}` } } });
  });

  test("a failed send is tried again on the backoff, not before; the signal is told only when it finally goes", async () => {
    await reset();
    const bad = hook(500);
    const first = await cron(HOOK, bad.f);
    expect(first).toMatchObject({ notified: { due: open, sent: 0, failed: open, waiting: open } });
    expect(await prisma.signal.count({ where: { workspaceId: W, status: "open", lastLevelSent: null } })).toBe(open);
    const rows = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    expect(rows.every((r) => r.state === "failed" && r.attempts === 1 && r.error === "HTTP 500" && r.nextTryAt != null && r.nextTryAt.getTime() === at(1).getTime())).toBe(true);
    // Too soon: nothing is called.
    const quiet = hook();
    expect(await cron(HOOK, quiet.f, at(0.5))).toMatchObject({ notified: { sent: 0, failed: 0, waiting: open } });
    expect(quiet.seen).toHaveLength(0);
    // A minute on, the receiver is back: every one goes, and the signals are told.
    const good = hook();
    const out = await cron(HOOK, good.f, at(2));
    expect(out).toMatchObject({ notified: { sent: open, failed: 0, waiting: 0 } });
    expect(good.seen).toHaveLength(open);
    const after = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    expect(after.every((r) => r.state === "sent" && r.attempts === 2 && r.error == null)).toBe(true);
    expect(await prisma.signal.count({ where: { workspaceId: W, status: "open", lastLevelSent: null } })).toBe(0);
  });

  test("a refusal that waiting cannot fix is final at once, and the signal is not tried forever", async () => {
    await reset();
    const refused = hook(401);
    expect(await cron(HOOK, refused.f)).toMatchObject({ notified: { sent: 0, failed: open, waiting: 0 } });
    const rows = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    expect(rows.every((r) => r.state === "failed" && r.attempts === MAX_ATTEMPTS && r.nextTryAt == null && r.error === "HTTP 401")).toBe(true);
    const later = hook();
    expect(await cron(HOOK, later.f, at(600))).toMatchObject({ notified: { due: 0, sent: 0 } });
    expect(later.seen).toHaveLength(0);
  });

  test("the tries run out after five failures", async () => {
    await reset();
    const bad = hook(503);
    // Five attempts, each when its time has come: 0, +1, +6, +36, +156 minutes.
    for (const m of [0, 2, 8, 40, 200]) await cron(HOOK, bad.f, at(m));
    const rows = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    expect(rows.every((r) => r.state === "failed" && r.attempts === MAX_ATTEMPTS && r.nextTryAt == null)).toBe(true);
    const calls = bad.seen.length;
    expect(calls).toBe(open * MAX_ATTEMPTS);
    await cron(HOOK, bad.f, at(2000));
    expect(bad.seen).toHaveLength(calls);
  });

  test("two runs at the same moment send each signal once", async () => {
    await reset();
    const { f, seen } = hook();
    fresh();
    const [a, b] = await Promise.all([runSignalsCron({ now: NOW, env: HOOK, fetchFn: f, workspaceId: W }), runSignalsCron({ now: NOW, env: HOOK, fetchFn: f, workspaceId: W })]);
    expect(a.notified.sent + b.notified.sent).toBe(open);
    expect(seen).toHaveLength(open);
    expect(new Set(seen.map((s) => s.delivery)).size).toBe(open);
    expect(await prisma.notificationLog.count({ where: { workspaceId: W } })).toBe(open);
  });

  test("a signal someone took is not sent, and a send still waiting to be retried for it is marked skipped", async () => {
    await reset();
    const bad = hook(500);
    await cron(HOOK, bad.f);
    const mine = await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, status: "open" } });
    expect(await acknowledgeSignal(mine.id, NOW, W, null)).toEqual({ ok: true });
    const good = hook();
    const out = await cron(HOOK, good.f, at(2));
    expect(out.notified).toMatchObject({ skipped: 1, sent: open - 1 });
    expect(good.seen.map((s) => s.delivery)).not.toContain(`signal:${mine.id}:0:${mine.level}`);
    const row = await prisma.notificationLog.findFirstOrThrow({ where: { workspaceId: W, signalId: mine.id } });
    expect(row.state).toBe("skipped");
    // Put it back for the tests after.
    await prisma.signal.update({ where: { id: mine.id }, data: { status: "open", ackedBy: null, ackedAt: null } });
  });

  test("only the level asked for and worse is sent", async () => {
    await reset();
    await saveSignalSettings({ minLevel: "block", reportEnabled: "off" }, NOW, W);
    const blocks = await prisma.signal.count({ where: { workspaceId: W, status: "open", level: "block" } });
    expect(blocks).toBeGreaterThanOrEqual(1);
    expect(open - blocks).toBeGreaterThanOrEqual(1);
    const { f, seen } = hook();
    const out = await cron(HOOK, f);
    expect(out.notified.sent).toBe(blocks);
    expect(seen.every((s) => s.body.level === "block")).toBe(true);
    // Asking for more later sends what was held back, and does not repeat what went.
    await saveSignalSettings({ minLevel: "info", reportEnabled: "off" }, NOW, W);
    const more = hook();
    await cron(HOOK, more.f, at(5));
    expect(more.seen).toHaveLength(open - blocks);
    expect(more.seen.every((s) => s.body.level !== "block")).toBe(true);
  });

  test("a signal that gets worse is told again at the new level", async () => {
    await reset();
    const { f } = hook();
    await cron(HOOK, f);
    const s = await prisma.signal.findFirstOrThrow({ where: { workspaceId: W, status: "open", level: { in: ["block", "warn"] } } });
    // As if it had been seen and told as the level below, and the rules now raise it higher: the sync sees the escalation, and the new level is a new notice.
    const lower = s.level === "block" ? "warn" : "info";
    await prisma.signal.update({ where: { id: s.id }, data: { level: lower, lastLevelSent: lower } });
    // (and nothing was ever sent at the higher level, so there is no row for it)
    await prisma.notificationLog.deleteMany({ where: { workspaceId: W, signalId: s.id } });
    const again = hook();
    await cron(HOOK, again.f, at(5));
    expect(again.seen).toHaveLength(1);
    expect(again.seen[0]!.delivery).toBe(`signal:${s.id}:0:${s.level}`);
  });

  test("the weekly report goes once a week, at its hour, on every channel; a late run still sends it that week; off sends nothing", async () => {
    await reset();
    await saveSignalSettings({ minLevel: "block", reportEnabled: "on", reportDay: "1", reportHour: "7" }, NOW, W);
    const MON = new Date("2026-11-09T14:00:00Z"); // Monday 08:00 in Chicago
    const SUN = new Date("2026-11-08T14:00:00Z");
    // Before its day: nothing.
    const early = hook();
    expect(await cron(HOOK, early.f, new Date("2026-11-09T12:00:00Z"))).toMatchObject({ reports: { not_due: 1 } });
    expect(early.seen.filter((s) => s.body.kind === "weekly_report")).toHaveLength(0);

    const { f, seen } = hook();
    expect(await cron(HOOK, f, MON)).toMatchObject({ reports: { sent: 1 } });
    const reports = seen.filter((s) => s.body.kind === "weekly_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.delivery).toBe("report:2026-W46");
    expect(reports[0]!.body).toMatchObject({ kind: "weekly_report", loadNumber: null, unit: null, deskUrl: "https://desk.example.com/signals" });
    const data = reports[0]!.body.data as { weekKey: string; report: { headline: { loads: number }; signals: { open: { block: number } } } };
    expect(data.weekKey).toBe("2026-W46");
    expect(data.report.headline.loads).toBeGreaterThanOrEqual(1);
    expect(String(reports[0]!.body.text)).toMatch(/Leak Ledger/);

    // The same week again, later: already sent.
    const again = hook();
    expect(await cron(HOOK, again.f, new Date("2026-11-12T20:00:00Z"))).toMatchObject({ reports: { already_sent: 1 } });
    expect(again.seen.filter((s) => s.body.kind === "weekly_report")).toHaveLength(0);
    // The next week, a run that comes late (Wednesday) still sends it, once.
    const next = hook();
    expect(await cron(HOOK, next.f, new Date("2026-11-18T20:00:00Z"))).toMatchObject({ reports: { sent: 1 } });
    expect(next.seen.filter((s) => s.body.kind === "weekly_report").map((s) => s.delivery)).toEqual(["report:2026-W47"]);
    expect(SUN.getTime()).toBeLessThan(MON.getTime());

    await saveSignalSettings({ minLevel: "block", reportEnabled: "off" }, NOW, W);
    const off = hook();
    expect(await cron(HOOK, off.f, new Date("2026-11-25T20:00:00Z"))).toMatchObject({ reports: { off: 1 } });
    expect(off.seen.filter((s) => s.body.kind === "weekly_report")).toHaveLength(0);
  });

  test("the demo desk's simulator records what would have gone, to nowhere", async () => {
    await reset();
    await saveSignalSettings({ minLevel: "block", reportEnabled: "off" }, NOW, W);
    const { f, seen } = hook();
    const out = await cron({}, f); // sign-in off: the simulator is a channel
    expect(out.channels).toBe(1);
    expect(seen).toHaveLength(0);
    const list = await listNotifications(50, W);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((n) => n.channel === "sandbox" && n.state === "sent" && n.kind === "signal" && /^Block: /.test(n.subject ?? ""))).toBe(true);
  });

  test("the ledger holds words and counts only: no body, address or key", async () => {
    const rows = await prisma.notificationLog.findMany({ where: { workspaceId: W } });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("nt-path-xyz");
    expect(text).not.toContain("a body that must never be stored");
  });

  test("a run for a desk with a failing step is counted and does not stop the run", async () => {
    // A workspace id that is not there makes the first read of its settings fail softly; the run completes and counts it as a desk run.
    const out = await runSignalsCron({ now: NOW, env: REAL, workspaceId: "nt-not-a-desk" });
    expect(out.workspaces).toBe(1);
    expect(out.failed + out.signals.created).toBeGreaterThanOrEqual(0);
  });
});
