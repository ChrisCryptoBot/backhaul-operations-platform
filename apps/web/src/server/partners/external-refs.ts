import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * Which partner record stands for which desk record, and how far each pull has read (docs/MONEY_PLAN.md, Wave 3). Every accounting sync goes through here, so it updates the record it made
 * before instead of creating a second one, and a record the company already has (a bookkeeper typed the customer first) is linked once found, never duplicated.
 *
 * A link is one to one, per company and kind of record: a desk record maps to one partner record and a partner record to one desk record. Linking either side to something else is refused
 * with what it is linked to now; changing a link is unlink then link, on purpose.
 */
export const REF_ENTITIES = ["customer", "invoice", "payment", "credit_memo", "vendor", "bill", "bill_payment", "item", "account", "journal_entry"] as const;
export type RefEntity = (typeof REF_ENTITIES)[number];

type Db = Prisma.TransactionClient | typeof prisma;

export type Ref = { localId: string; externalId: string; syncToken: string | null; pushedHash: string | null; syncedAt: Date };

/** What the desk sends, as a short fingerprint: the same content gives the same hash whatever order its keys were written in, so "nothing changed since the last push" is one comparison. */
export function contentHash(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Date) return v.toISOString();
    if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toFixed(2);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(norm(value))).digest("hex").slice(0, 32);
}

const pick = (r: { localId: string; externalId: string; syncToken: string | null; pushedHash: string | null; syncedAt: Date }): Ref => ({ localId: r.localId, externalId: r.externalId, syncToken: r.syncToken, pushedHash: r.pushedHash, syncedAt: r.syncedAt });

export async function refOf(provider: string, entity: RefEntity, localId: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<Ref | null> {
  const r = await db.externalRef.findUnique({ where: { workspaceId_provider_entity_localId: { workspaceId, provider, entity, localId } } });
  return r ? pick(r) : null;
}

export async function refByExternal(provider: string, entity: RefEntity, externalId: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<Ref | null> {
  const r = await db.externalRef.findUnique({ where: { workspaceId_provider_entity_externalId: { workspaceId, provider, entity, externalId } } });
  return r ? pick(r) : null;
}

/** Many desk records' links at once (for a push of a list). */
export async function refsOf(provider: string, entity: RefEntity, localIds: string[], workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<Map<string, Ref>> {
  if (localIds.length === 0) return new Map();
  const rows = await db.externalRef.findMany({ where: { workspaceId, provider, entity, localId: { in: localIds } } });
  return new Map(rows.map((r) => [r.localId, pick(r)]));
}

export type LinkResult = { ok: true; created: boolean } | { ok: false; error: string; conflict: "local" | "external" };

/**
 * Link a desk record to a partner record, or record a new push on a link that exists (its version and what was sent). Refused when either side is already linked to something else. Safe
 * under two pushes at once: the unique indexes decide, and the loser is told what won.
 */
export async function linkRef(
  args: { provider: string; entity: RefEntity; localId: string; externalId: string; syncToken?: string | null; pushedHash?: string | null },
  now = new Date(),
  workspaceId = currentWorkspaceId(),
  db: Db = prisma
): Promise<LinkResult> {
  const { provider, entity, localId, externalId } = args;
  if (!externalId || externalId.length > 128) return { ok: false, error: "The company's record id is missing or too long.", conflict: "external" };
  const mine = await db.externalRef.findUnique({ where: { workspaceId_provider_entity_localId: { workspaceId, provider, entity, localId } } });
  if (mine && mine.externalId !== externalId) return { ok: false, error: `This ${entity.replace("_", " ")} is already linked to ${mine.externalId} there.`, conflict: "local" };
  const theirs = await db.externalRef.findUnique({ where: { workspaceId_provider_entity_externalId: { workspaceId, provider, entity, externalId } } });
  if (theirs && theirs.localId !== localId) return { ok: false, error: `Their ${entity.replace("_", " ")} ${externalId} is already linked to another record on the desk.`, conflict: "external" };
  const data = { syncedAt: now, ...(args.syncToken !== undefined ? { syncToken: args.syncToken } : {}), ...(args.pushedHash !== undefined ? { pushedHash: args.pushedHash } : {}) };
  if (mine) {
    await db.externalRef.update({ where: { id: mine.id }, data });
    return { ok: true, created: false };
  }
  try {
    await db.externalRef.create({ data: { workspaceId, provider, entity, localId, externalId, ...data } });
    return { ok: true, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Another sync linked this record at the same moment. Run it again.", conflict: "local" };
    throw e;
  }
}

export async function unlinkRef(provider: string, entity: RefEntity, localId: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<boolean> {
  const out = await db.externalRef.deleteMany({ where: { workspaceId, provider, entity, localId } });
  return out.count > 0;
}

// ── Cursors ────────────────────────────────────────────────────────────────────────────────

export type Cursor = { cursor: string | null; lastRunAt: Date | null; lastOkAt: Date | null; lastError: string | null };

export async function readCursor(provider: string, stream: string, workspaceId = currentWorkspaceId()): Promise<Cursor> {
  const r = await prisma.syncCursor.findUnique({ where: { workspaceId_provider_stream: { workspaceId, provider, stream } } });
  return r ? { cursor: r.cursor, lastRunAt: r.lastRunAt, lastOkAt: r.lastOkAt, lastError: r.lastError } : { cursor: null, lastRunAt: null, lastOkAt: null, lastError: null };
}

/**
 * Move a pull's cursor from where it was read (`from`) to where the pull got to (`to`), only if no other run moved it meanwhile. A run that lost answers false and keeps nothing it read
 * past the cursor, so a page of changes is neither skipped nor applied twice. The first run reads from null.
 */
export async function advanceCursor(provider: string, stream: string, from: string | null, to: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<boolean> {
  if (from === null) {
    try {
      await prisma.syncCursor.create({ data: { workspaceId, provider, stream, cursor: to, lastRunAt: now, lastOkAt: now } });
      return true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      // A row exists: it may still be at null (an earlier run failed before it read anything).
      const moved = await prisma.syncCursor.updateMany({ where: { workspaceId, provider, stream, cursor: null }, data: { cursor: to, lastRunAt: now, lastOkAt: now, lastError: null } });
      return moved.count === 1;
    }
  }
  const moved = await prisma.syncCursor.updateMany({ where: { workspaceId, provider, stream, cursor: from }, data: { cursor: to, lastRunAt: now, lastOkAt: now, lastError: null } });
  return moved.count === 1;
}

/** A pull that failed: the cursor stays where it was, so the next run reads the same changes again. */
export async function cursorFailed(provider: string, stream: string, error: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<void> {
  await prisma.syncCursor.upsert({
    where: { workspaceId_provider_stream: { workspaceId, provider, stream } },
    update: { lastRunAt: now, lastError: error.slice(0, 300) },
    create: { workspaceId, provider, stream, cursor: null, lastRunAt: now, lastError: error.slice(0, 300) }
  });
}
