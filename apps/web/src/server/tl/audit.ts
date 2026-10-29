import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AUDIT_GROUPS, type AuditAction, type AuditSnapshot } from "@/lib/audit-diff";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * The audit trail. `recordAudit` is called from inside the same transaction as the change it describes, so an event
 * exists exactly when its change does. Events are never edited or deleted by the desk.
 */
export type AuditDb = PrismaClient | Prisma.TransactionClient;

export type AuditInput = {
  entity: "assignment" | "load" | "invoice" | "intake" | "settings" | "fleet" | "settlement" | "customer";
  action: AuditAction;
  summary: string;
  loadId?: string | null;
  loadNumber?: string | null;
  reason?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  at?: Date;
  workspaceId?: string;
};

export const DESK_ACTOR = "Dispatcher";

export async function recordAudit(i: AuditInput, db: AuditDb = prisma) {
  return db.auditEvent.create({
    data: {
      workspaceId: i.workspaceId ?? DEMO_WORKSPACE_ID,
      loadId: i.loadId ?? null,
      loadNumber: i.loadNumber ?? null,
      entity: i.entity,
      action: i.action,
      summary: i.summary,
      reason: i.reason?.trim() ? i.reason.trim() : null,
      before: i.before ? (i.before as Prisma.InputJsonObject) : undefined,
      after: i.after ? (i.after as Prisma.InputJsonObject) : undefined,
      actor: DESK_ACTOR,
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

export type AuditFilter = { q?: string; group?: string; page?: number; pageSize?: number };

/** Newest first, with the filters the audit page offers. `total` counts the matches, not just this page. */
export async function listAudit(f: AuditFilter = {}, workspaceId = DEMO_WORKSPACE_ID) {
  const pageSize = f.pageSize ?? 50;
  const page = f.page && f.page > 0 ? f.page : 1;
  const group = AUDIT_GROUPS.find((g) => g.key === f.group);
  const q = f.q?.trim();
  const where: Prisma.AuditEventWhereInput = {
    workspaceId,
    ...(group ? { action: { in: group.actions } } : {}),
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

/** The activity feed on a load. */
export async function listLoadAudit(loadId: string, limit = 25): Promise<AuditRow[]> {
  const rows = await prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.map(toRow);
}
