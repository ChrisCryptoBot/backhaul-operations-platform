import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { RULES, type AlertCode, type AlertLevel } from "@/lib/alerts";
import { clampPage, diffSignals, type DerivedSignal, type SignalState, type StoredSignal } from "@/lib/signals";
import { resolveSignalSettings, validateSignalSettings, reportWhen, LEVEL_CHOICES, type SignalSettings, type SignalSettingsCheck, type SignalSettingsRow } from "@/lib/signal-settings";
import type { Terminals } from "@/lib/scope";
import { getAlerts } from "./alerts";
import { recordAudit } from "./audit";
import { currentActor } from "./identity";
import { lockWorkspace } from "./plan";
import { currentAllowed } from "./scope";
import { terminalSetSql } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";

/**
 * Signals (docs/SIGNALS.md): the alerts the rules derive on every request, kept. `syncSignals` makes the stored list follow the rules (lib/signals.ts says how); `listSignals` reads it back inside the
 * person's scope; `acknowledgeSignal` says someone is on one. A signal is never deleted: one that clears is resolved, and one that comes back is reopened with its history.
 */
const CHUNK = 500;
const titleOf = (code: string) => RULES.find((r) => r.code === (code as AlertCode))?.title ?? code;

// ── Settings (what is told, and when the weekly report goes) ─────────────────────────────────────

export async function getStoredSignalSettings(workspaceId = currentWorkspaceId()): Promise<SignalSettingsRow> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { signalMinLevel: true, reportEnabled: true, reportDay: true, reportHour: true } });
  return ws ? { minLevel: ws.signalMinLevel, reportEnabled: ws.reportEnabled, reportDay: ws.reportDay, reportHour: ws.reportHour } : {};
}

export async function getSignalSettings(workspaceId = currentWorkspaceId()): Promise<SignalSettings> {
  return resolveSignalSettings(await getStoredSignalSettings(workspaceId));
}

const settingsWords = (s: SignalSettings) => ({
  "Tell people about": LEVEL_CHOICES.find((c) => c.key === s.minLevel)?.label ?? s.minLevel,
  "Weekly report": s.reportEnabled ? reportWhen(s) : "Off"
});

/** Checks and saves the settings; saving what is already stored writes nothing. The audit event says what moved, in the words of the form. */
export async function saveSignalSettings(input: Record<string, unknown>, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SignalSettingsCheck & { changed?: boolean }> {
  const check = validateSignalSettings(input);
  if (!check.ok) return check;
  const was = await getStoredSignalSettings(workspaceId);
  // Compared as the desk reads them, so saving the defaults over nothing stored is no change.
  const a = resolveSignalSettings(was);
  const b = check.resolved;
  const same = a.minLevel === b.minLevel && a.reportEnabled === b.reportEnabled && a.reportDay === b.reportDay && a.reportHour === b.reportHour;
  if (same) return { ...check, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { signalMinLevel: check.stored.minLevel, reportEnabled: check.stored.reportEnabled, reportDay: check.stored.reportDay, reportHour: check.stored.reportHour } });
    await recordAudit({ entity: "settings", action: "signal_settings_changed", summary: "Changed what the desk tells people about", before: settingsWords(resolveSignalSettings(was)), after: settingsWords(check.resolved), at: now, workspaceId }, tx);
  });
  return { ...check, changed: true };
}

// ── Keeping the list ─────────────────────────────────────────────────────────────────────────────

type StoredRow = { id: string; key: string; level: string; status: string; first_seen_at: Date; last_seen_at: Date; resolved_at: Date | null; reopen_count: number; last_level_sent: string | null };

const stored = (r: StoredRow): StoredSignal => ({
  id: r.id,
  key: r.key,
  level: r.level as AlertLevel,
  status: r.status as SignalState,
  firstSeenAt: r.first_seen_at.getTime(),
  lastSeenAt: r.last_seen_at.getTime(),
  resolvedAt: r.resolved_at ? r.resolved_at.getTime() : null,
  reopenCount: r.reopen_count,
  lastLevelSent: r.last_level_sent as AlertLevel | null
});

export type SyncResult = { created: number; seen: number; reopened: number; resolved: number; escalated: number };

/**
 * Makes the stored signals follow what the rules derive now, for the WHOLE desk (a person's scope narrows what they read, never what is kept). The alerts are worked out first (kept for the minute by
 * the alert cache), then everything is written in one transaction with the workspace locked, so two syncs at once cannot both create the same signal. The work is a handful of statements whatever the
 * number of alerts: one read, one insert per 500 new, one update for everything still derived, one for everything that cleared.
 */
export async function syncSignals(now = new Date(), workspaceId = currentWorkspaceId()): Promise<SyncResult> {
  const { alerts } = await getAlerts(now, workspaceId, "all");
  const derived: DerivedSignal[] = alerts.map((a) => ({ key: a.key, code: a.code, level: a.level, title: titleOf(a.code), detail: a.message, loadId: a.loadId, loadNumber: a.loadNumber }));
  const keys = [...new Set(derived.map((d) => d.key))];
  return prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Everything not resolved, and the resolved ones that have come back (a resolved one still not derived changes nothing, so is not read).
      const rows = await tx.$queryRaw<StoredRow[]>`select id, key, level, status, first_seen_at, last_seen_at, resolved_at, reopen_count, last_level_sent from signals where workspace_id = ${workspaceId} and (status <> 'resolved' or key = any(${keys}::text[]))`;
      const changes = diffSignals(rows.map(stored), derived);
      const result: SyncResult = { created: 0, seen: 0, reopened: 0, resolved: 0, escalated: 0 };

      const fresh = changes.filter((c) => c.kind === "new").map((c) => c.signal);
      for (let i = 0; i < fresh.length; i += CHUNK) {
        const part = fresh.slice(i, i + CHUNK);
        await tx.signal.createMany({ data: part.map((d) => ({ workspaceId, key: d.key, code: d.code, level: d.level, title: d.title, detail: d.detail, loadId: d.loadId, loadNumber: d.loadNumber, status: "open", firstSeenAt: now, lastSeenAt: now })) });
      }
      result.created = fresh.length;

      // One statement for everything still derived: last seen moves, the words and level follow the rules, and an acknowledged signal that got worse is open again.
      const seen = changes.filter((c) => c.kind === "seen");
      for (let i = 0; i < seen.length; i += CHUNK) {
        const part = seen.slice(i, i + CHUNK);
        await tx.$executeRaw`
          update signals s set last_seen_at = ${now}, level = v.level, title = v.title, detail = v.detail, load_number = v.load_number, updated_at = ${now},
            status = case when s.status = 'acknowledged' and v.escalated then 'open' else s.status end,
            acked_by = case when s.status = 'acknowledged' and v.escalated then null else s.acked_by end,
            acked_at = case when s.status = 'acknowledged' and v.escalated then null else s.acked_at end
          from unnest(${part.map((c) => c.id)}::text[], ${part.map((c) => c.signal.level)}::text[], ${part.map((c) => c.signal.title)}::text[], ${part.map((c) => c.signal.detail)}::text[], ${part.map((c) => c.signal.loadNumber)}::text[], ${part.map((c) => c.escalated)}::boolean[])
            as v(id, level, title, detail, load_number, escalated)
          where s.id = v.id and s.workspace_id = ${workspaceId}`;
      }
      result.seen = seen.length;
      result.escalated = seen.filter((c) => c.escalated).length;

      // Back after clearing: open again, first seen kept, the count of returns up, and what was sent forgotten so it is news again.
      const back = changes.filter((c) => c.kind === "reopened");
      for (let i = 0; i < back.length; i += CHUNK) {
        const part = back.slice(i, i + CHUNK);
        await tx.$executeRaw`
          update signals s set status = 'open', resolved_at = null, reopen_count = s.reopen_count + 1, acked_by = null, acked_at = null, last_level_sent = null,
            last_seen_at = ${now}, level = v.level, title = v.title, detail = v.detail, load_number = v.load_number, updated_at = ${now}
          from unnest(${part.map((c) => c.id)}::text[], ${part.map((c) => c.signal.level)}::text[], ${part.map((c) => c.signal.title)}::text[], ${part.map((c) => c.signal.detail)}::text[], ${part.map((c) => c.signal.loadNumber)}::text[])
            as v(id, level, title, detail, load_number)
          where s.id = v.id and s.workspace_id = ${workspaceId}`;
      }
      result.reopened = back.length;

      const gone = changes.filter((c) => c.kind === "resolved").map((c) => c.id);
      for (let i = 0; i < gone.length; i += CHUNK) await tx.signal.updateMany({ where: { workspaceId, id: { in: gone.slice(i, i + CHUNK) } }, data: { status: "resolved", resolvedAt: now } });
      result.resolved = gone.length;
      return result;
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}

// ── Reading the list ─────────────────────────────────────────────────────────────────────────────

export type SignalRow = {
  id: string;
  key: string;
  code: string;
  level: AlertLevel;
  title: string;
  detail: string;
  loadId: string | null;
  loadNumber: string | null;
  status: SignalState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  reopenCount: number;
  ackedBy: string | null;
  ackedAt: Date | null;
};

export type SignalCounts = { open: number; acknowledged: number; resolved: number; /** Open ones by level. */ byLevel: Record<AlertLevel, number> };
export const SIGNAL_PAGE_SIZE = 50;

/**
 * The scope in SQL for `signals s left join loads l`: a desk-wide view keeps every signal; a narrowed one keeps the signals of loads placed in the scope (or not placed anywhere), the same rule as every
 * other list. A signal with no load is whole-desk news and is shown only when no terminal is chosen.
 */
const scoped = (terminal: Terminals, workspaceId: string) => (terminal == null ? Prisma.empty : Prisma.sql` and l.id is not null${terminalSetSql(terminal, workspaceId)}`);

export async function signalCounts(terminal: Terminals = null, workspaceId = currentWorkspaceId()): Promise<SignalCounts> {
  const rows = await prisma.$queryRaw<Array<{ status: string; level: string; n: number }>>`
    select s.status, s.level, count(*)::int as n from signals s left join loads l on l.id = s.load_id
    where s.workspace_id = ${workspaceId}${scoped(terminal, workspaceId)} group by s.status, s.level`;
  const out: SignalCounts = { open: 0, acknowledged: 0, resolved: 0, byLevel: { block: 0, warn: 0, info: 0 } };
  for (const r of rows) {
    if (r.status === "open") {
      out.open += r.n;
      out.byLevel[r.level as AlertLevel] += r.n;
    } else if (r.status === "acknowledged") out.acknowledged += r.n;
    else if (r.status === "resolved") out.resolved += r.n;
  }
  return out;
}

export type SignalQuery = { status?: SignalState; level?: AlertLevel | null; page?: number };

/** One page of signals in the scope: open ones worst first and oldest first, acknowledged ones newest acknowledgement first, resolved ones newest first. */
export async function listSignals(q: SignalQuery, terminal: Terminals = null, workspaceId = currentWorkspaceId()): Promise<{ rows: SignalRow[]; total: number; page: number; pageSize: number }> {
  const status = q.status ?? "open";
  const level = q.level === "block" || q.level === "warn" || q.level === "info" ? q.level : null;
  const where = Prisma.sql`s.workspace_id = ${workspaceId} and s.status = ${status}${level ? Prisma.sql` and s.level = ${level}` : Prisma.empty}${scoped(terminal, workspaceId)}`;
  const order =
    status === "open"
      ? Prisma.sql`case s.level when 'block' then 0 when 'warn' then 1 else 2 end, s.first_seen_at, s.id`
      : status === "acknowledged"
        ? Prisma.sql`s.acked_at desc, s.id`
        : Prisma.sql`s.resolved_at desc, s.id`;
  const [{ n: total } = { n: 0 }] = await prisma.$queryRaw<Array<{ n: number }>>`select count(*)::int as n from signals s left join loads l on l.id = s.load_id where ${where}`;
  const { page } = clampPage(q.page, total, SIGNAL_PAGE_SIZE);
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`select s.id from signals s left join loads l on l.id = s.load_id where ${where} order by ${order} limit ${SIGNAL_PAGE_SIZE} offset ${(page - 1) * SIGNAL_PAGE_SIZE}`;
  const found = await prisma.signal.findMany({ where: { workspaceId, id: { in: ids.map((r) => r.id) } } });
  const byId = new Map(found.map((s) => [s.id, s]));
  const rows: SignalRow[] = [];
  for (const { id } of ids) {
    const s = byId.get(id);
    if (s) rows.push({ id: s.id, key: s.key, code: s.code, level: s.level as AlertLevel, title: s.title, detail: s.detail, loadId: s.loadId, loadNumber: s.loadNumber, status: s.status as SignalState, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, resolvedAt: s.resolvedAt, reopenCount: s.reopenCount, ackedBy: s.ackedBy, ackedAt: s.ackedAt });
  }
  return { rows, total, page, pageSize: SIGNAL_PAGE_SIZE };
}

// ── Acknowledging ────────────────────────────────────────────────────────────────────────────────

export type AckResult = { ok: true } | { ok: false; error: string };

/**
 * Says someone is on a signal: it leaves the open list (and is not sent about) until it clears, or gets worse. The person must be able to see it: a limited person cannot acknowledge a signal of a load outside
 * their terminals by guessing its id, and gets the same answer as for one that does not exist. Audited, with the load.
 */
export async function acknowledgeSignal(id: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<AckResult> {
  const limit = allowed === undefined ? await currentAllowed(workspaceId) : allowed;
  const gone: AckResult = { ok: false, error: "That signal is no longer on the desk." };
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const seen = await tx.$queryRaw<Array<{ id: string }>>`select s.id from signals s left join loads l on l.id = s.load_id where s.id = ${id} and s.workspace_id = ${workspaceId}${scoped(limit, workspaceId)}`;
    if (seen.length === 0) return gone;
    const s = await tx.signal.findFirst({ where: { id, workspaceId } });
    if (!s) return gone;
    if (s.status === "resolved") return { ok: false, error: "That signal has already cleared." } as AckResult;
    if (s.status === "acknowledged") return { ok: false, error: `Already acknowledged${s.ackedBy ? ` by ${s.ackedBy}` : ""}.` } as AckResult;
    const who = currentActor();
    await tx.signal.update({ where: { id }, data: { status: "acknowledged", ackedBy: who, ackedAt: now } });
    await recordAudit({ entity: "load", entityId: s.id, action: "signal_acknowledged", summary: `${s.title}${s.loadNumber ? ` on ${s.loadNumber}` : ""} acknowledged`, loadId: s.loadId, loadNumber: s.loadNumber, before: { Signal: "Open" }, after: { Signal: "Acknowledged", By: who }, at: now, workspaceId }, tx);
    return { ok: true } as AckResult;
  });
}

// ── Keeping it fresh without a clock ────────────────────────────────────────────────────────────

const lastSync = new Map<string, number>();
/** Tests clear it between cases. */
export const clearSyncThrottle = () => lastSync.clear();

/**
 * For a page that shows the list: syncs unless this server did it in the last minute (the alert answer is kept for the minute anyway), so a screen is never older than a minute with or without the
 * scheduled run, and ten people opening it at once do the work once. A failed sync is not remembered, so the next view tries again.
 */
export async function syncSignalsIfStale(now = new Date(), workspaceId = currentWorkspaceId()): Promise<SyncResult | null> {
  const at = now.getTime();
  const last = lastSync.get(workspaceId);
  if (last != null && at - last < 60_000 && at >= last) return null;
  lastSync.set(workspaceId, at);
  try {
    return await syncSignals(now, workspaceId);
  } catch (e) {
    lastSync.delete(workspaceId);
    throw e;
  }
}
