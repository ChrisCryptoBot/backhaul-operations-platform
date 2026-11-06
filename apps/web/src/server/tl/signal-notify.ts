import { prisma } from "@/lib/db";
import type { AlertLevel } from "@/lib/alerts";
import { dollarsOf, signalNotice } from "@/lib/notify";
import { LEVEL_RANK, notifyDue, type SignalState } from "@/lib/signals";
import { deliver } from "@/server/notify/deliver";
import type { Channel, Env, Fetch } from "@/server/notify";
import { numOrNull } from "./convert";
import { getSignalSettings } from "./signals";
import { currentWorkspaceId } from "./workspace";

/**
 * Telling people about signals. A signal is told once per level it reaches, on every channel that is set up: `notifyDue` (lib/signals.ts) says which are due, the ledger (server/notify/deliver.ts) makes
 * each send once, and a signal is remembered as told (`last_level_sent`) only when every channel is finished with it, so one that failed is tried again on the next run. A signal someone acknowledged,
 * or that cleared, is not told, and a notification still waiting to be retried for one is marked skipped. At most 100 a run, worst first, so turning this on over a long list does not flood a channel.
 */
export const MAX_PER_RUN = 100;

export type NotifyCounts = { channels: number; due: number; sent: number; failed: number; waiting: number; skipped: number };
const none = (channels: number): NotifyCounts => ({ channels, due: 0, sent: 0, failed: 0, waiting: 0, skipped: 0 });

type DueRow = { id: string; key: string; code: string; level: string; title: string; detail: string; load_id: string | null; load_number: string | null; first_seen_at: Date; reopen_count: number; last_level_sent: string | null; status: string };

export async function notifyOpenSignals(channels: readonly Channel[], now: Date, deskUrl: string | null, env: Env, fetchFn: Fetch, workspaceId = currentWorkspaceId()): Promise<NotifyCounts> {
  if (channels.length === 0) return none(0);
  const out = none(channels.length);
  // Retries still waiting for a signal that has since cleared or been taken: nobody needs telling any more.
  out.skipped = await prisma.$executeRaw`update notification_log set state = 'skipped', next_try_at = null where workspace_id = ${workspaceId} and state in ('queued', 'failed') and signal_id in (select id from signals where workspace_id = ${workspaceId} and status <> 'open')`;

  const { minLevel } = await getSignalSettings(workspaceId);
  const levels = (Object.keys(LEVEL_RANK) as AlertLevel[]).filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[minLevel]);
  const rows = await prisma.$queryRaw<DueRow[]>`
    select id, key, code, level, title, detail, load_id, load_number, first_seen_at, reopen_count, last_level_sent, status from signals
    where workspace_id = ${workspaceId} and status = 'open' and level = any(${levels}::text[])
      and (last_level_sent is null or (case last_level_sent when 'block' then 0 when 'warn' then 1 else 2 end) > (case level when 'block' then 0 when 'warn' then 1 else 2 end))
    order by (case level when 'block' then 0 when 'warn' then 1 else 2 end), first_seen_at, id
    limit ${MAX_PER_RUN}`;
  const due = rows.filter((r) => notifyDue({ status: r.status as SignalState, level: r.level as AlertLevel, lastLevelSent: r.last_level_sent as AlertLevel | null }, minLevel));
  out.due = due.length;
  if (due.length === 0) return out;

  // The load's number, the truck and the figure a workflow formats from, in one read for the whole run.
  const loadIds = [...new Set(due.map((r) => r.load_id).filter((x): x is string => x != null))];
  const loads = await prisma.load.findMany({ where: { workspaceId, id: { in: loadIds } }, select: { id: true, invoicedAmount: true, actualRevenue: true, quotedRevenue: true, vehicle: { select: { name: true } } } });
  const byId = new Map(loads.map((l) => [l.id, l]));

  for (const r of due) {
    const l = r.load_id ? byId.get(r.load_id) : undefined;
    const notice = signalNotice({
      id: r.id,
      key: r.key,
      code: r.code,
      level: r.level as AlertLevel,
      title: r.title,
      detail: r.detail,
      loadId: r.load_id,
      loadNumber: r.load_number,
      unit: l?.vehicle?.name ?? null,
      dollars: dollarsOf(r.code, l ? { invoicedAmount: numOrNull(l.invoicedAmount), actualRevenue: numOrNull(l.actualRevenue), quotedRevenue: numOrNull(l.quotedRevenue) } : null),
      firstSeenAt: r.first_seen_at.getTime(),
      reopenCount: r.reopen_count,
      deskUrl
    });
    const d = await deliver(workspaceId, notice, channels, r.id, now, env, fetchFn);
    out.sent += d.sent;
    out.failed += d.failed;
    out.waiting += d.waiting;
    // Remembered as told only when every channel is finished with it; and only if it is still open at that level (a person may have taken it while it was being sent).
    if (d.settled) await prisma.signal.updateMany({ where: { id: r.id, workspaceId, status: "open", level: r.level }, data: { lastLevelSent: r.level } });
  }
  return out;
}

/** The latest notifications, for the screen that shows what went out. */
export type NotificationRow = { id: string; at: Date; channel: string; state: string; subject: string | null; attempts: number; error: string | null; kind: string };

export async function listNotifications(limit = 50, workspaceId = currentWorkspaceId()): Promise<NotificationRow[]> {
  const rows = await prisma.notificationLog.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
  return rows.map((r) => ({ id: r.id, at: r.sentAt ?? r.createdAt, channel: r.channel, state: r.state, subject: r.subject, attempts: r.attempts, error: r.error, kind: r.kind }));
}
