import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { decryptSecret, encryptSecret, lastFour } from "@/lib/crypto-config";

// DAT market-rate API credentials. Mirrors server/llm/settings.ts (same AES-256-GCM
// at-rest pattern). Supports EITHER a pre-minted token/API key OR a DAT iQ / RateView
// service account (username + password + user email) — whichever the customer has.
// The live provider auto-detects; no creds → deterministic mock.

const CONFIG_ID = "default";

/** Masked, non-sensitive view of the DAT configuration for UI/read paths. */
export interface DatSettingsStatus {
  isActive: boolean;
  hasKey: boolean;
  apiKeyLast4: string | null;
  /** True when a service-account username + password are stored. */
  hasServiceAccount: boolean;
  userEmail: string | null;
  updatedAt: string | null;
}

export async function getDatSettingsStatus(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<DatSettingsStatus> {
  const row = await db.datProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row) {
    return { isActive: true, hasKey: false, apiKeyLast4: null, hasServiceAccount: false, userEmail: null, updatedAt: null };
  }
  return {
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    hasServiceAccount: Boolean(row.usernameCipher && row.passwordCipher),
    userEmail: row.userEmail,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Server-only decrypted credentials for outbound DAT calls. Never sent to a client. */
export interface DatCredentials {
  token: string | null;
  username: string | null;
  password: string | null;
  userEmail: string | null;
}

/**
 * Server-only: decrypted DAT credentials, or all-null when unset/inactive or on a
 * decrypt failure (so callers fall back to the mock). Prefer a token if present;
 * otherwise the caller runs the service-account OAuth with username/password.
 */
export async function getDatCredentials(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<DatCredentials> {
  const empty: DatCredentials = { token: null, username: null, password: null, userEmail: null };
  const row = await db.datProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row || !row.isActive) return empty;
  try {
    return {
      token: row.apiKeyCipher ? decryptSecret(row.apiKeyCipher) : null,
      username: row.usernameCipher ? decryptSecret(row.usernameCipher) : null,
      password: row.passwordCipher ? decryptSecret(row.passwordCipher) : null,
      userEmail: row.userEmail
    };
  } catch {
    return empty;
  }
}

/** Back-compat: just the token/API key (or null). */
export async function getDatApiKey(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<string | null> {
  return (await getDatCredentials(db)).token;
}

export interface UpdateDatSettingsInput {
  actorId: string;
  /** Plaintext token/API key; omit/empty to keep the existing stored value. */
  apiKey?: string;
  /** Service-account username; omit/empty to keep existing. */
  username?: string;
  /** Service-account password; omit/empty to keep existing. */
  password?: string;
  /** Service-account user email (plain identifier). */
  userEmail?: string;
  isActive?: boolean;
}

/**
 * Encrypts the API key (when provided), upserts the singleton config row, and writes
 * an audit entry. The plaintext key is never logged — audit records only the masked
 * last-4 and metadata.
 */
export async function updateDatSettings(
  input: UpdateDatSettingsInput,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<DatSettingsStatus> {
  const existing = await db.datProviderConfig.findUnique({ where: { id: CONFIG_ID } });

  const provided = (v: string | undefined): v is string => typeof v === "string" && v.trim().length > 0;
  const hasNewKey = provided(input.apiKey);
  const hasNewUser = provided(input.username);
  const hasNewPass = provided(input.password);

  const apiKeyCipher = hasNewKey ? encryptSecret(input.apiKey!.trim()) : existing?.apiKeyCipher ?? null;
  const apiKeyLast4 = hasNewKey ? lastFour(input.apiKey!.trim()) : existing?.apiKeyLast4 ?? null;
  const usernameCipher = hasNewUser ? encryptSecret(input.username!.trim()) : existing?.usernameCipher ?? null;
  const passwordCipher = hasNewPass ? encryptSecret(input.password!.trim()) : existing?.passwordCipher ?? null;
  const userEmail = provided(input.userEmail) ? input.userEmail!.trim() : existing?.userEmail ?? null;
  const isActive = input.isActive ?? existing?.isActive ?? true;

  const row = await db.datProviderConfig.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, apiKeyCipher, apiKeyLast4, usernameCipher, passwordCipher, userEmail, isActive, updatedById: input.actorId },
    update: { apiKeyCipher, apiKeyLast4, usernameCipher, passwordCipher, userEmail, isActive, updatedById: input.actorId }
  });

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "DatProviderConfig",
      entityId: row.id,
      action: existing ? "UPDATE" : "CREATE",
      actorId: input.actorId,
      timestamp: new Date(),
      beforeValue: existing ? { apiKeyLast4: existing.apiKeyLast4, isActive: existing.isActive } : Prisma.JsonNull,
      afterValue: {
        apiKeyLast4: row.apiKeyLast4,
        isActive: row.isActive,
        keyRotated: hasNewKey,
        serviceAccountRotated: hasNewUser || hasNewPass,
        userEmail: row.userEmail
      }
    })
  });

  return {
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    hasServiceAccount: Boolean(row.usernameCipher && row.passwordCipher),
    userEmail: row.userEmail,
    updatedAt: row.updatedAt.toISOString()
  };
}
