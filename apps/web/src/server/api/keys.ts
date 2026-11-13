import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { LAST_USED_EVERY_MS, LOOKUP_LENGTH, MAX_ACTIVE_KEYS, RATE_LIMIT, RATE_WINDOW_MS, SCOPE_LABEL, SECRET_BYTES, bearerOf, cleanKeyInput, formatKey, maskKey, parseKey, retryAfterSeconds, type ApiScope, type KeyMode } from "@/lib/api-keys";
import { recordAudit } from "@/server/tl/audit";
import { checkFeature } from "@/server/partners/gates";

/**
 * Partner read API keys (docs/MONEY_PLAN.md, Wave 7 step 2): make, revoke, list, and believe one. Every function takes the workspace explicitly; nothing here reads a person's session, a cookie
 * or the request's default workspace (tests/api-tenancy.test.ts holds this folder to that). The whole key is returned once, by `createApiKey`, and never stored or logged: the row keeps its
 * SHA-256, its public prefix and its last four characters.
 */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const LOOKUP_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function lookupPart(): string {
  // 36 symbols from bytes: reject the top of the range so each symbol is equally likely.
  let out = "";
  while (out.length < LOOKUP_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < 252 && out.length < LOOKUP_LENGTH) out += LOOKUP_ALPHABET[b % 36];
    }
  }
  return out;
}

export type CreatedKey = { ok: true; id: string; key: string; masked: string } | { ok: false; error: string };

/** Make a key. The plan must have the read API; a fleet keeps at most a handful of keys in use. The key comes back once, here. */
export async function createApiKey(input: { label: unknown; scopes: unknown }, who: string, now: Date, workspaceId: string, mode: KeyMode): Promise<CreatedKey> {
  const plan = await checkFeature("read_api", workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const clean = cleanKeyInput(input);
  if (!clean.ok) return clean;
  const name = who.trim().slice(0, 120) || "Admin";
  for (let attempt = 0; attempt < 3; attempt++) {
    const lookup = lookupPart();
    const key = formatKey(mode, lookup, randomBytes(SECRET_BYTES).toString("base64url"));
    const prefix = parseKey(key)!.prefix;
    const last4 = key.slice(-4);
    try {
      const id = await prisma.$transaction(async (tx) => {
        const active = await tx.partnerApiKey.count({ where: { workspaceId, revokedAt: null } });
        if (active >= MAX_ACTIVE_KEYS) return null;
        const row = await tx.partnerApiKey.create({ data: { workspaceId, label: clean.label, prefix, last4, hash: sha256(key), scopes: clean.scopes, createdBy: name, createdAt: now } });
        await recordAudit(
          { entity: "partner", entityId: row.id, action: "api_key_created", summary: `API key "${clean.label}" made by ${name} (${maskKey(prefix, last4)}), may read ${clean.scopes.map((s) => SCOPE_LABEL[s].toLowerCase()).join(", ")}`, after: { Key: maskKey(prefix, last4), Reads: clean.scopes.join(", ") }, at: now, workspaceId },
          tx
        );
        return row.id;
      });
      if (!id) return { ok: false, error: `This fleet already has ${MAX_ACTIVE_KEYS} keys in use. Revoke one first.` };
      return { ok: true, id, key, masked: maskKey(prefix, last4) };
    } catch (e) {
      // Two keys with the same 8-character prefix (1 in 2.8 trillion): make another.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
  return { ok: false, error: "The key could not be made. Try again." };
}

export type RevokeResult = { ok: true; changed: boolean } | { ok: false; error: string };

/** Revoke a key for good: from the next request on it is refused. Revoking twice changes nothing. */
export async function revokeApiKey(id: string, who: string, now: Date, workspaceId: string): Promise<RevokeResult> {
  const name = who.trim().slice(0, 120) || "Admin";
  return prisma.$transaction(async (tx) => {
    const row = await tx.partnerApiKey.findFirst({ where: { id, workspaceId } });
    if (!row) return { ok: false as const, error: "That key does not exist." };
    const out = await tx.partnerApiKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: now, revokedBy: name } });
    if (out.count === 0) return { ok: true as const, changed: false };
    await recordAudit({ entity: "partner", entityId: id, action: "api_key_revoked", summary: `API key "${row.label}" revoked by ${name} (${maskKey(row.prefix, row.last4)})`, before: { Key: "In use" }, after: { Key: "Revoked" }, at: now, workspaceId }, tx);
    return { ok: true as const, changed: true };
  });
}

export type KeyRow = { id: string; label: string; masked: string; scopes: ApiScope[]; createdBy: string | null; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; revokedBy: string | null };

/** What a screen may say about a fleet's keys: never the hash. In use first, newest first. */
export async function listApiKeys(workspaceId: string): Promise<KeyRow[]> {
  const rows = await prisma.partnerApiKey.findMany({ where: { workspaceId }, orderBy: [{ revokedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }], take: 100 });
  return rows.map((r) => ({ id: r.id, label: r.label, masked: maskKey(r.prefix, r.last4), scopes: r.scopes as ApiScope[], createdBy: r.createdBy, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt, revokedBy: r.revokedBy }));
}

export type AuthOk = { ok: true; keyId: string; workspaceId: string; remaining: number };
export type AuthFail = { ok: false; status: 401 | 403 | 429; code: "unauthenticated" | "revoked" | "forbidden_scope" | "plan" | "rate_limited"; message: string; retryAfter?: number };

const fail = (status: AuthFail["status"], code: AuthFail["code"], message: string, retryAfter?: number): AuthFail => ({ ok: false, status, code, message, ...(retryAfter != null ? { retryAfter } : {}) });
const UNKNOWN = "Send a valid API key: Authorization: Bearer tlk_...";

/**
 * Believe a request, in this order: a Bearer header; a key shaped like ours; its row by prefix; the hash, compared in constant time; not revoked; the scope this route needs; the plan; and the
 * rate window. Only after all of them does a caller learn the workspace. The rate window and `last_used_at` move in one UPDATE on the key's row, which Postgres serializes per row, so a burst
 * of parallel requests counts exactly and none slips past the limit.
 */
export async function authenticate(header: string | null, scope: ApiScope, now: Date): Promise<AuthOk | AuthFail> {
  const token = bearerOf(header);
  if (!token) return fail(401, "unauthenticated", UNKNOWN);
  const parsed = parseKey(token);
  if (!parsed) return fail(401, "unauthenticated", UNKNOWN);
  const row = await prisma.partnerApiKey.findUnique({ where: { prefix: parsed.prefix }, select: { id: true, workspaceId: true, hash: true, scopes: true, revokedAt: true } });
  // A wrong key and an unknown prefix answer the same, after the same amount of hashing.
  const given = Buffer.from(sha256(token), "hex");
  const kept = Buffer.from(row?.hash ?? "0".repeat(64), "hex");
  const same = given.length === kept.length && timingSafeEqual(given, kept);
  if (!row || !same) return fail(401, "unauthenticated", UNKNOWN);
  if (row.revokedAt) return fail(401, "revoked", "This API key was revoked. Ask the fleet for a new one.");
  if (!row.scopes.includes(scope)) return fail(403, "forbidden_scope", `This key may not read ${scope}. The fleet's admin chooses what a key may read when it is made.`);
  const plan = await checkFeature("read_api", row.workspaceId);
  if (!plan.ok) return fail(403, "plan", "The read API is not on this fleet's plan.");
  const cutoff = new Date(now.getTime() - RATE_WINDOW_MS);
  const usedCutoff = new Date(now.getTime() - LAST_USED_EVERY_MS);
  const hit = await prisma.$queryRaw<Array<{ window_start: Date; window_count: number }>>`
    UPDATE "partner_api_keys" SET
      "window_start" = CASE WHEN "window_start" IS NULL OR "window_start" <= ${cutoff} THEN ${now} ELSE "window_start" END,
      "window_count" = CASE WHEN "window_start" IS NULL OR "window_start" <= ${cutoff} THEN 1 ELSE "window_count" + 1 END,
      "last_used_at" = CASE WHEN "last_used_at" IS NULL OR "last_used_at" <= ${usedCutoff} THEN ${now} ELSE "last_used_at" END
    WHERE "id" = ${row.id} AND "revoked_at" IS NULL
    RETURNING "window_start", "window_count"`;
  const w = hit[0];
  if (!w) return fail(401, "revoked", "This API key was revoked. Ask the fleet for a new one."); // revoked between the read and the count
  if (w.window_count > RATE_LIMIT) return fail(429, "rate_limited", `At most ${RATE_LIMIT} requests a minute per key. Try again shortly.`, retryAfterSeconds(w.window_start, now));
  return { ok: true, keyId: row.id, workspaceId: row.workspaceId, remaining: RATE_LIMIT - w.window_count };
}
