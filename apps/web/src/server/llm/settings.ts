import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { encryptSecret, lastFour } from "@/lib/crypto-config";

const CONFIG_ID = "default";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5";

/** Masked, non-sensitive view of the LLM configuration for UI/read paths. */
export interface LlmSettingsStatus {
  provider: string;
  model: string;
  copilotModel: string | null;
  isActive: boolean;
  hasKey: boolean;
  apiKeyLast4: string | null;
  updatedAt: string | null;
}

export async function getLlmSettingsStatus(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<LlmSettingsStatus> {
  const row = await db.llmProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row) {
    return {
      provider: process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER,
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      copilotModel: process.env.COPILOT_MODEL ?? null,
      isActive: true,
      // An env-var bootstrap key counts as "configured" for display purposes.
      hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
      apiKeyLast4: null,
      updatedAt: null
    };
  }
  return {
    provider: row.provider,
    model: row.model,
    copilotModel: row.copilotModel,
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    updatedAt: row.updatedAt.toISOString()
  };
}

export interface UpdateLlmSettingsInput {
  actorId: string;
  provider: string;
  model: string;
  /** Copilot (tool-use) model; null/undefined keeps the default. */
  copilotModel?: string | null;
  /** Plaintext key; omit/empty to keep the existing stored key. */
  apiKey?: string;
  isActive?: boolean;
}

/**
 * Encrypts the API key (when provided), upserts the singleton config row, and
 * writes an audit entry. The plaintext key is never logged — audit records only
 * the masked last-4 and metadata.
 */
export async function updateLlmSettings(
  input: UpdateLlmSettingsInput,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<LlmSettingsStatus> {
  const existing = await db.llmProviderConfig.findUnique({ where: { id: CONFIG_ID } });

  const hasNewKey = typeof input.apiKey === "string" && input.apiKey.trim().length > 0;
  const apiKeyCipher = hasNewKey ? encryptSecret(input.apiKey!.trim()) : existing?.apiKeyCipher ?? null;
  const apiKeyLast4 = hasNewKey ? lastFour(input.apiKey!.trim()) : existing?.apiKeyLast4 ?? null;
  const isActive = input.isActive ?? existing?.isActive ?? true;
  const copilotModel =
    input.copilotModel === undefined ? existing?.copilotModel ?? null : input.copilotModel || null;

  const row = await db.llmProviderConfig.upsert({
    where: { id: CONFIG_ID },
    create: {
      id: CONFIG_ID,
      provider: input.provider,
      model: input.model,
      copilotModel,
      apiKeyCipher,
      apiKeyLast4,
      isActive,
      updatedById: input.actorId
    },
    update: {
      provider: input.provider,
      model: input.model,
      copilotModel,
      apiKeyCipher,
      apiKeyLast4,
      isActive,
      updatedById: input.actorId
    }
  });

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "LlmProviderConfig",
      entityId: row.id,
      action: existing ? "UPDATE" : "CREATE",
      actorId: input.actorId,
      timestamp: new Date(),
      beforeValue: existing
        ? { provider: existing.provider, model: existing.model, apiKeyLast4: existing.apiKeyLast4, isActive: existing.isActive }
        : Prisma.JsonNull,
      afterValue: {
        provider: row.provider,
        model: row.model,
        apiKeyLast4: row.apiKeyLast4,
        isActive: row.isActive,
        keyRotated: hasNewKey
      }
    })
  });

  return {
    provider: row.provider,
    model: row.model,
    copilotModel: row.copilotModel,
    isActive: row.isActive,
    hasKey: Boolean(row.apiKeyCipher),
    apiKeyLast4: row.apiKeyLast4,
    updatedAt: row.updatedAt.toISOString()
  };
}
