import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { encryptSecret, lastFour } from "@/lib/crypto-config";

// DAT market-rate API credentials. Mirrors server/llm/settings.ts (same AES-256-GCM
// at-rest pattern) but key-only — there is no provider/model to choose. Not yet wired
// to a live DAT API; storing the key now lets manual market rates be swapped for the
// API later without a settings migration.

const CONFIG_ID = "default";

/** Masked, non-sensitive view of the DAT configuration for UI/read paths. */
export interface DatSettingsStatus {
  isActive: boolean;
  hasKey: boolean;
  apiKeyLast4: string | null;
  updatedAt: string | null;
}

export async function getDatSettingsStatus(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<DatSettingsStatus> {
  const row = await db.datProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row) {
    return { isActive: true, hasKey: false, apiKeyLast4: null, updatedAt: null };
  }
  return {
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    updatedAt: row.updatedAt.toISOString()
  };
}

export interface UpdateDatSettingsInput {
  actorId: string;
  /** Plaintext key; omit/empty to keep the existing stored key. */
  apiKey?: string;
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

  const hasNewKey = typeof input.apiKey === "string" && input.apiKey.trim().length > 0;
  const apiKeyCipher = hasNewKey ? encryptSecret(input.apiKey!.trim()) : existing?.apiKeyCipher ?? null;
  const apiKeyLast4 = hasNewKey ? lastFour(input.apiKey!.trim()) : existing?.apiKeyLast4 ?? null;
  const isActive = input.isActive ?? existing?.isActive ?? true;

  const row = await db.datProviderConfig.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, apiKeyCipher, apiKeyLast4, isActive, updatedById: input.actorId },
    update: { apiKeyCipher, apiKeyLast4, isActive, updatedById: input.actorId }
  });

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "DatProviderConfig",
      entityId: row.id,
      action: existing ? "UPDATE" : "CREATE",
      actorId: input.actorId,
      timestamp: new Date(),
      beforeValue: existing ? { apiKeyLast4: existing.apiKeyLast4, isActive: existing.isActive } : Prisma.JsonNull,
      afterValue: { apiKeyLast4: row.apiKeyLast4, isActive: row.isActive, keyRotated: hasNewKey }
    })
  });

  return {
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    updatedAt: row.updatedAt.toISOString()
  };
}
