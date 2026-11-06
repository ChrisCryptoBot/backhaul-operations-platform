import { prisma } from "@/lib/db";
import { ageDays } from "@/lib/signals";
import { reportDue, reportNotice, weekKeyAt, type WeeklyReport } from "@/lib/weekly-report";
import { deliver, settledChannels, type Delivery } from "@/server/notify/deliver";
import type { Channel, Env, Fetch } from "@/server/notify";
import { getDataHealth } from "./data-health";
import { getDeskKpi } from "./kpi";
import { getLeakLedger } from "./leaks";
import { getSignalSettings } from "./signals";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

const DAY = 86_400_000;

/**
 * The weekly report's figures: the last four weeks' headline, the Leak Ledger and Data health exactly as those screens work them out (this adds no sum of its own), and the signals' counts. Always the
 * WHOLE desk: it goes to the people who run it, not to one terminal.
 */
export async function buildWeeklyReport(now = new Date(), workspaceId = currentWorkspaceId()): Promise<WeeklyReport> {
  const tz = await workspaceTimezone(workspaceId);
  const since = new Date(now.getTime() - 7 * DAY);
  const [kpi, ledger, health, byStatus, oldest, fresh, cleared] = await Promise.all([
    getDeskKpi({ period: "4w", compare: false }, now, workspaceId),
    getLeakLedger({ period: "4w", compare: false }, now, workspaceId),
    getDataHealth({ period: "4w" }, now, workspaceId),
    prisma.signal.groupBy({ by: ["status", "level"], where: { workspaceId, status: { not: "resolved" } }, _count: { _all: true } }),
    prisma.signal.findFirst({ where: { workspaceId, status: "open" }, orderBy: { firstSeenAt: "asc" }, select: { firstSeenAt: true } }),
    prisma.signal.count({ where: { workspaceId, firstSeenAt: { gte: since } } }),
    prisma.signal.count({ where: { workspaceId, resolvedAt: { gte: since } } })
  ]);
  const open = { block: 0, warn: 0, info: 0 };
  let acknowledged = 0;
  for (const g of byStatus) {
    if (g.status === "open" && (g.level === "block" || g.level === "warn" || g.level === "info")) open[g.level] += g._count._all;
    else if (g.status === "acknowledged") acknowledged += g._count._all;
  }
  const c = kpi.current;
  const lines = ledger.current.lines.filter((l) => l.items > 0).sort((a, b) => b.dollars - a.dollars);
  return {
    weekKey: weekKeyAt(now.getTime(), tz),
    asOf: now.getTime(),
    windowLabel: "Last four weeks",
    headline: { loads: c.loads, gross: c.gross, rpm: c.rpm, emptyShare: c.emptyShare },
    leaks: { total: ledger.current.total, items: ledger.current.items, unpriced: ledger.current.unpriced, lines: lines.map((l) => ({ label: l.label, dollars: l.dollars, items: l.items })), openDwellDollars: ledger.openDwell.dollars, openDwellTrailers: ledger.openDwell.trailers },
    health: { score: health.completeness.score == null ? null : health.completeness.score * 100, gaps: health.completeness.checks.filter((k) => k.gaps > 0).sort((a, b) => b.gaps - a.gaps).map((k) => ({ label: k.label, gaps: k.gaps })) },
    signals: { open, acknowledged, oldestOpenDays: oldest ? ageDays({ firstSeenAt: oldest.firstSeenAt.getTime(), resolvedAt: null }, now.getTime()) : null, newThisWeek: fresh, clearedThisWeek: cleared }
  };
}

export type ReportRun = { state: "off" | "no_channel" | "not_due" | "already_sent" | "sent" | "failed" | "waiting"; weekKey: string | null; delivery: Delivery | null };

/**
 * Sends this week's report if it is on, a channel is set up, the carrier's clock has reached the day and hour, and this week's has not already gone out on every channel. The ledger's key is the ISO week,
 * so a second run (or a second server) the same week sends nothing more, and a run that comes late still sends it within the week.
 */
export async function sendWeeklyReport(channels: readonly Channel[], now: Date, deskUrl: string | null, env: Env, fetchFn: Fetch, workspaceId = currentWorkspaceId()): Promise<ReportRun> {
  const settings = await getSignalSettings(workspaceId);
  if (!settings.reportEnabled) return { state: "off", weekKey: null, delivery: null };
  if (channels.length === 0) return { state: "no_channel", weekKey: null, delivery: null };
  const tz = await workspaceTimezone(workspaceId);
  const due = reportDue(settings, now.getTime(), tz);
  if (!due.due) return { state: "not_due", weekKey: due.weekKey, delivery: null };
  // Before building anything: is this week's already told on every channel?
  if ((await settledChannels(workspaceId, { dedupeKey: `report:${due.weekKey}` }, channels)) === channels.length) return { state: "already_sent", weekKey: due.weekKey, delivery: null };
  const notice = reportNotice(await buildWeeklyReport(now, workspaceId), deskUrl);
  const delivery = await deliver(workspaceId, notice, channels, null, now, env, fetchFn);
  // "sent" if anything went out on any channel in this run; "failed" if every try failed; "waiting" if every channel is held or not due yet.
  return { state: delivery.sent > 0 ? "sent" : delivery.failed > 0 ? "failed" : "waiting", weekKey: due.weekKey, delivery };
}
