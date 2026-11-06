import { prisma } from "@/lib/db";
import { configuredChannels, type Env, type Fetch } from "@/server/notify";
import { notifyOpenSignals, type NotifyCounts } from "./signal-notify";
import { syncSignals, type SyncResult } from "./signals";
import { sendWeeklyReport, type ReportRun } from "./weekly-report";

/**
 * One scheduled run (docs/SIGNALS.md): for every desk, keep the signals up to date, tell people about what is due, and send the weekly report if its time has come. Whatever calls the cron route
 * (n8n's Schedule trigger, or the host's own cron later) makes this run, every few minutes. The answer is counts and nothing else: no name, id, address or key. One desk failing does not stop the
 * others, and is counted.
 */
export const MAX_WORKSPACES = 500;

export type CronCounts = {
  workspaces: number;
  /** The channels this server is set up for (the simulator counts, where it is on). Zero means nothing leaves the desk. */
  channels: number;
  signals: SyncResult;
  notified: NotifyCounts;
  reports: Record<ReportRun["state"], number>;
  failed: number;
};

const zero = (): CronCounts => ({
  workspaces: 0,
  channels: 0,
  signals: { created: 0, seen: 0, reopened: 0, resolved: 0, escalated: 0 },
  notified: { channels: 0, due: 0, sent: 0, failed: 0, waiting: 0, skipped: 0 },
  reports: { off: 0, no_channel: 0, not_due: 0, already_sent: 0, sent: 0, failed: 0, waiting: 0 },
  failed: 0
});

export type CronOptions = { now?: Date; env?: Env; fetchFn?: Fetch; deskUrl?: string | null; workspaceId?: string };

export async function runSignalsCron(o: CronOptions = {}): Promise<CronCounts> {
  const now = o.now ?? new Date();
  const env = o.env ?? process.env;
  const fetchFn = o.fetchFn ?? fetch;
  const channels = configuredChannels(env);
  const deskUrl = env.NOTIFY_DESK_URL?.trim() || o.deskUrl || null;
  const out = zero();
  out.channels = channels.length;
  const desks = o.workspaceId ? [{ id: o.workspaceId }] : await prisma.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: MAX_WORKSPACES });
  for (const { id } of desks) {
    out.workspaces += 1;
    try {
      const s = await syncSignals(now, id);
      out.signals.created += s.created;
      out.signals.seen += s.seen;
      out.signals.reopened += s.reopened;
      out.signals.resolved += s.resolved;
      out.signals.escalated += s.escalated;
      const n = await notifyOpenSignals(channels, now, deskUrl, env, fetchFn, id);
      out.notified.channels = n.channels;
      out.notified.due += n.due;
      out.notified.sent += n.sent;
      out.notified.failed += n.failed;
      out.notified.waiting += n.waiting;
      out.notified.skipped += n.skipped;
      const r = await sendWeeklyReport(channels, now, deskUrl, env, fetchFn, id);
      out.reports[r.state] += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
