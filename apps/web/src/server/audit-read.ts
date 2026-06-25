import { prisma } from "@/lib/db";

export interface AuditHistoryEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  actorName: string | null;
  timestamp: string;
  reason: string | null;
  beforeValue: unknown;
  afterValue: unknown;
}

/**
 * Read the change history for one entity (e.g. a load or broker) from the AuditLog,
 * most recent first. Entity-scoped: the caller resolves the entity id through a
 * region-scoped lookup first, so history is implicitly region-correct.
 */
export async function getAuditHistory(input: {
  entityId: string;
  entityType?: string;
  limit?: number;
}): Promise<AuditHistoryEntry[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await prisma.auditLog.findMany({
    where: {
      entityId: input.entityId,
      ...(input.entityType ? { entityType: input.entityType } : {})
    },
    orderBy: { timestamp: "desc" },
    take: limit
  });
  const nameById = await resolveUserNames(rows.map((row) => row.actorId));
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    actorId: row.actorId,
    actorName: nameById.get(row.actorId) ?? null,
    timestamp: row.timestamp.toISOString(),
    reason: row.reason,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue
  }));
}

export interface AuditLogPage {
  entries: AuditHistoryEntry[];
  /** Opaque cursor (an AuditLog id) for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export interface AuditLogFilter {
  entityType?: string;
  action?: string;
  actorId?: string;
  /** Inclusive lower bound on timestamp. */
  from?: Date;
  /** Inclusive upper bound on timestamp. */
  to?: Date;
  /** Free-text match across entityId, action, and reason (case-insensitive). */
  search?: string;
  /** AuditLog id to page after (entries are returned newest-first). */
  cursor?: string;
  limit?: number;
}

/**
 * Browse the global audit trail newest-first with optional filters and cursor pagination.
 *
 * NOTE on region scoping: the AuditLog table is not region-tagged (no regionId column), and the
 * app currently operates in a single Phase-1 region. This read is therefore global by design and
 * is gated to admins at the page/API layer. If the product goes multi-region, add `AuditLog.regionId`
 * (populated at write time in {@link createAuditLog} call sites) and filter on it here.
 */
export async function listAuditLog(input: AuditLogFilter = {}): Promise<AuditLogPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const search = input.search?.trim();

  const where = {
    ...(input.entityType ? { entityType: input.entityType } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.from || input.to
      ? { timestamp: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
    ...(search
      ? {
          OR: [
            { entityId: { contains: search, mode: "insensitive" as const } },
            { action: { contains: search, mode: "insensitive" as const } },
            { reason: { contains: search, mode: "insensitive" as const } }
          ]
        }
      : {})
  };

  // Fetch one extra row to determine whether a further page exists.
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {})
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nameById = await resolveUserNames(pageRows.map((row) => row.actorId));

  return {
    entries: pageRows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      actorId: row.actorId,
      actorName: nameById.get(row.actorId) ?? null,
      timestamp: row.timestamp.toISOString(),
      reason: row.reason,
      beforeValue: row.beforeValue,
      afterValue: row.afterValue
    })),
    nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null
  };
}

export interface AuditFilterOptions {
  entityTypes: string[];
  actions: string[];
}

/** Distinct entityType + action values for populating the audit browser's filter dropdowns. */
export async function getAuditFilterOptions(): Promise<AuditFilterOptions> {
  const [types, actions] = await Promise.all([
    prisma.auditLog.findMany({ distinct: ["entityType"], select: { entityType: true }, orderBy: { entityType: "asc" } }),
    prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } })
  ]);
  return {
    entityTypes: types.map((row) => row.entityType),
    actions: actions.map((row) => row.action)
  };
}

/** Resolve user ids to a human label (name, falling back to email). Best-effort. */
export async function resolveUserNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true }
  });
  return new Map(users.map((user) => [user.id, user.name ?? user.email ?? user.id]));
}
