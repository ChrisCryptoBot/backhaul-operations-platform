import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AUDIT_GROUPS, type AuditAction, type AuditSnapshot } from "@/lib/audit-diff";
import { auditRange } from "@/lib/audit-range";
import { DESK_ACTOR, currentActor } from "./identity";
import { currentWorkspaceId } from "./workspace";
import { termList, type Terminals } from "@/lib/scope";
import { terminalSetSql } from "./terminal-sql";

/**
 * The audit trail. `recordAudit` is called from inside the same transaction as the change it describes, so an event
 * exists exactly when its change does. Events are never edited or deleted by the desk.
 */
export type AuditDb = PrismaClient | Prisma.TransactionClient;

export type AuditInput = {
  entity: "assignment" | "load" | "invoice" | "intake" | "settings" | "fleet" | "settlement" | "customer" | "trailer" | "partner";
  /** The record the event is about (a trailer's id), so its history is found by id. */
  entityId?: string | null;
  action: AuditAction;
  summary: string;
  loadId?: string | null;
  loadNumber?: string | null;
  reason?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  at?: Date;
  workspaceId?: string;
  /** Who did it; the signed-in person by default ("Dispatcher" with sign-in off). */
  actor?: string;
};

export { DESK_ACTOR };

export async function recordAudit(i: AuditInput, db: AuditDb = prisma) {
  return db.auditEvent.create({
    data: {
      workspaceId: i.workspaceId ?? currentWorkspaceId(),
      loadId: i.loadId ?? null,
      loadNumber: i.loadNumber ?? null,
      entity: i.entity,
      entityId: i.entityId ?? null,
      action: i.action,
      summary: i.summary,
      reason: i.reason?.trim() ? i.reason.trim() : null,
      before: i.before ? (i.before as Prisma.InputJsonObject) : undefined,
      after: i.after ? (i.after as Prisma.InputJsonObject) : undefined,
      actor: i.actor ?? currentActor(),
      createdAt: i.at
    }
  });
}

export type AuditRow = {
  id: string;
  loadId: string | null;
  loadNumber: string | null;
  entity: string;
  action: string;
  summary: string;
  reason: string | null;
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  actor: string;
  createdAt: Date;
};

const snap = (v: Prisma.JsonValue | null): AuditSnapshot | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as AuditSnapshot) : null);

function toRow(e: { id: string; loadId: string | null; loadNumber: string | null; entity: string; action: string; summary: string; reason: string | null; before: Prisma.JsonValue | null; after: Prisma.JsonValue | null; actor: string; createdAt: Date }): AuditRow {
  return { ...e, before: snap(e.before), after: snap(e.after) };
}

export type AuditFilter = { q?: string; group?: string; from?: string; to?: string; page?: number; pageSize?: number };

/**
 * Newest first, with the filters the audit page offers (search, area, From and To day). `total` counts the matches, not just this page.
 *
 * `terminals` narrows it to the terminals in view: an event on a load follows the load (its truck or driver, or not placed yet), an event on a truck, driver or trailer follows that unit's terminal, and an
 * event about neither (settings, the team, regions, customers, partners) is shown only to someone who can see every terminal (`unlimited`), since it names things outside any one terminal.
 */
export async function listAudit(f: AuditFilter = {}, workspaceId = currentWorkspaceId(), terminals: Terminals = null, unlimited = true) {
  const pageSize = f.pageSize ?? 50;
  const page = f.page && f.page > 0 ? f.page : 1;
  const group = AUDIT_GROUPS.find((g) => g.key === f.group);
  const q = f.q?.trim();
  const range = auditRange(f.from, f.to);
  const list = termList(terminals);
  if (list != null) return listAuditIn(list, unlimited, { group: group?.actions, q, range, page, pageSize }, workspaceId);
  const where: Prisma.AuditEventWhereInput = {
    workspaceId,
    ...(group ? { action: { in: group.actions } } : {}),
    ...(range.gte || range.lt ? { createdAt: range } : {}),
    ...(q
      ? {
          OR: [
            { loadNumber: { contains: q, mode: "insensitive" } },
            { summary: { contains: q, mode: "insensitive" } },
            { reason: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };
  const [rows, total, all] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.count({ where: { workspaceId } })
  ]);
  return { rows: rows.map(toRow), total, all, page, pageSize };
}

/** The history of one record (a trailer), newest first, found by its id. */
export async function listEntityAudit(entityId: string, limit = 25, workspaceId = currentWorkspaceId()): Promise<AuditRow[]> {
  const rows = await prisma.auditEvent.findMany({ where: { entityId, workspaceId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map(toRow);
}

/** The activity feed on a load. */
export async function listLoadAudit(loadId: string, limit = 25, workspaceId = currentWorkspaceId()): Promise<AuditRow[]> {
  const rows = await prisma.auditEvent.findMany({ where: { loadId, workspaceId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map(toRow);
}

/** The same list for some terminals only, read in SQL (an event has no terminal of its own: it is found through its load or its unit). */
async function listAuditIn(list: string[], unlimited: boolean, f: { group?: string[]; q?: string; range: { gte?: Date; lt?: Date }; page: number; pageSize: number }, workspaceId: string) {
  /** The ids of the trucks, drivers and trailers: those of the terminals in view, or every one (to tell an event about a unit from one about something else). */
  const units = (narrow: boolean) => Prisma.sql`select v.id from vehicles v where v.workspace_id = ${workspaceId}${narrow ? Prisma.sql` and v.terminal = any(${list})` : Prisma.empty}
    union all select d.id from drivers d where d.workspace_id = ${workspaceId}${narrow ? Prisma.sql` and d.terminal = any(${list})` : Prisma.empty}
    union all select t.id from trailers t where t.workspace_id = ${workspaceId}${narrow ? Prisma.sql` and t.terminal = any(${list})` : Prisma.empty}`;
  const here = Prisma.sql`(
    (e.load_id is not null and e.load_id in (select l.id from loads l where l.workspace_id = ${workspaceId}${terminalSetSql(list, workspaceId)}))
    or (e.entity_id is not null and e.entity_id in (${units(true)}))
    ${unlimited ? Prisma.sql`or (e.load_id is null and (e.entity_id is null or e.entity_id not in (${units(false)})))` : Prisma.empty}
  )`;
  const base = [Prisma.sql`e.workspace_id = ${workspaceId}`, here];
  const conds = [...base];
  if (f.group) conds.push(Prisma.sql`e.action = any(${f.group})`);
  if (f.range.gte) conds.push(Prisma.sql`e.created_at >= ${f.range.gte}`);
  if (f.range.lt) conds.push(Prisma.sql`e.created_at < ${f.range.lt}`);
  if (f.q) {
    const like = `%${f.q.replace(/[\%_]/g, (c) => `\${c}`)}%`;
    conds.push(Prisma.sql`(e.load_number ilike ${like} or e.summary ilike ${like} or e.reason ilike ${like})`);
  }
  const where = Prisma.join(conds, " and ");
  const [rows, total, all] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; loadId: string | null; loadNumber: string | null; entity: string; action: string; summary: string; reason: string | null; before: Prisma.JsonValue | null; after: Prisma.JsonValue | null; actor: string; createdAt: Date }>>`
      select e.id, e.load_id as "loadId", e.load_number as "loadNumber", e.entity, e.action, e.summary, e.reason, e.before, e.after, e.actor, e.created_at as "createdAt"
      from audit_events e where ${where} order by e.created_at desc offset ${(f.page - 1) * f.pageSize} limit ${f.pageSize}`,
    prisma.$queryRaw<Array<{ n: number }>>`select count(*)::int as n from audit_events e where ${where}`,
    prisma.$queryRaw<Array<{ n: number }>>`select count(*)::int as n from audit_events e where ${Prisma.join(base, " and ")}`
  ]);
  return { rows: rows.map(toRow), total: total[0]?.n ?? 0, all: all[0]?.n ?? 0, page: f.page, pageSize: f.pageSize };
}
