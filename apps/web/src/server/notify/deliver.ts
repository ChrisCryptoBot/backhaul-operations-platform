import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { LEASE_MINUTES, MAX_ATTEMPTS, nextTryAfter, type Notice } from "@/lib/notify";
import type { Channel, Env, Fetch } from "./types";

/**
 * Sending a notice once. The ledger (notification_log) holds one row per notice and channel per desk, unique on (workspace, `<channel>:<dedupe key>`), and every send starts by claiming that row in ONE
 * statement:
 *   - no row yet: it is inserted already claimed (one try counted, held for a few minutes), and this run sends;
 *   - a row that failed and whose time to try again has come, or whose hold ran out (a send that died): it is claimed again, and this run sends;
 *   - anything else (already sent, tries used up, being sent by someone else right now, waiting for its time): nothing is returned, and this run does not send.
 * So two runs at the same moment cannot both send, whatever the timing: the database decides, not the code. A send that dies after the receiver got it can be sent again once the hold runs out
 * (at least once, never lost); the dedupe key goes with it so a receiver can drop the repeat.
 */
export type Delivery = {
  /** Every channel is finished with this notice: sent, or out of tries. Only then is the notice remembered as told. */
  settled: boolean;
  sent: number;
  /** A try that failed in this run (it will be tried again unless the tries are used up). */
  failed: number;
  /** A channel that is not due yet, or is held by another run. */
  waiting: number;
};

type Claimed = { id: string; attempts: number };

const keyOf = (channel: string, notice: Notice) => `${channel}:${notice.dedupeKey}`;

async function claim(workspaceId: string, notice: Notice, channel: Channel, signalId: string | null, now: Date): Promise<Claimed | null> {
  const hold = new Date(now.getTime() + LEASE_MINUTES * 60_000);
  const rows = await prisma.$queryRaw<Array<{ id: string; attempts: number }>>`
    insert into notification_log (id, workspace_id, kind, dedupe_key, channel, state, attempts, signal_id, subject, created_at, next_try_at)
    values (${randomUUID()}, ${workspaceId}, ${notice.kind}, ${keyOf(channel.name, notice)}, ${channel.name}, 'queued', 1, ${signalId}, ${notice.subject.slice(0, 200)}, ${now}, ${hold})
    on conflict (workspace_id, dedupe_key) do update
      set attempts = notification_log.attempts + 1, state = 'queued', next_try_at = ${hold}
      where notification_log.state in ('queued', 'failed') and notification_log.attempts < ${MAX_ATTEMPTS} and notification_log.next_try_at is not null and notification_log.next_try_at <= ${now}
    returning id, attempts`;
  return rows[0] ?? null;
}

/** What a channel's row says when this run did not claim it: finished (sent, skipped, out of tries) or still to come. */
async function standing(workspaceId: string, notice: Notice, channel: Channel): Promise<"done" | "waiting"> {
  const row = await prisma.notificationLog.findUnique({ where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: keyOf(channel.name, notice) } }, select: { state: true, attempts: true } });
  if (!row) return "waiting";
  if (row.state === "sent" || row.state === "skipped") return "done";
  return row.state === "failed" && row.attempts >= MAX_ATTEMPTS ? "done" : "waiting";
}

/** Sends a notice on every channel, once each. `signalId` ties the rows to the signal they are about. */
export async function deliver(workspaceId: string, notice: Notice, channels: readonly Channel[], signalId: string | null, now: Date, env: Env, fetchFn: Fetch): Promise<Delivery> {
  const out: Delivery = { settled: true, sent: 0, failed: 0, waiting: 0 };
  for (const channel of channels) {
    const got = await claim(workspaceId, notice, channel, signalId, now);
    if (!got) {
      if ((await standing(workspaceId, notice, channel)) === "waiting") {
        out.waiting += 1;
        out.settled = false;
      }
      continue;
    }
    const result = await channel.send(notice, env, fetchFn).catch(() => ({ ok: false as const, error: "send failed", retry: true }));
    if (result.ok) {
      await prisma.notificationLog.update({ where: { id: got.id }, data: { state: "sent", sentAt: now, nextTryAt: null, error: null } });
      out.sent += 1;
      continue;
    }
    // A failure that waiting cannot fix is final at once; otherwise the next try follows the backoff, until the tries are used up.
    const next = result.retry ? nextTryAfter(got.attempts, now.getTime()) : null;
    await prisma.notificationLog.update({ where: { id: got.id }, data: { state: "failed", error: result.error.slice(0, 120), nextTryAt: next == null ? null : new Date(next), ...(result.retry ? {} : { attempts: MAX_ATTEMPTS }) } });
    out.failed += 1;
    if (next != null) {
      out.waiting += 1;
      out.settled = false;
    }
  }
  return out;
}

/** The channels that have already finished with a notice (so a report week already told is not built again). */
export async function settledChannels(workspaceId: string, notice: Pick<Notice, "dedupeKey">, channels: readonly Channel[]): Promise<number> {
  const rows = await prisma.notificationLog.findMany({ where: { workspaceId, dedupeKey: { in: channels.map((c) => `${c.name}:${notice.dedupeKey}`) } }, select: { state: true, attempts: true } });
  return rows.filter((r) => r.state === "sent" || r.state === "skipped" || (r.state === "failed" && r.attempts >= MAX_ATTEMPTS)).length;
}
