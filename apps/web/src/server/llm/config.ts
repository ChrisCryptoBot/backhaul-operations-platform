import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto-config";

export interface ActiveLlmConfig {
  provider: string;
  model: string;
  apiKey: string;
}

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5";
// The copilot does multi-step tool reasoning, so it defaults to a stronger
// model than the (cost-optimized) parser.
const DEFAULT_COPILOT_MODEL = "claude-sonnet-4-6";

/**
 * Resolves the active LLM configuration, preferring the runtime-managed row in
 * `LlmProviderConfig` (with the API key decrypted) and falling back to the
 * optional env-var bootstrap (ANTHROPIC_API_KEY / LLM_PROVIDER / LLM_MODEL).
 *
 * Returns `null` when nothing is configured — callers treat that as "no LLM
 * available" and fall back to the regex parser.
 */
export async function getActiveLlmConfig(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<ActiveLlmConfig | null> {
  const row = await db.llmProviderConfig.findUnique({ where: { id: "default" } });
  if (row && row.isActive && row.apiKeyCipher) {
    try {
      const apiKey = decryptSecret(row.apiKeyCipher);
      if (apiKey.trim().length > 0) {
        return { provider: row.provider, model: row.model, apiKey };
      }
    } catch {
      // Decryption failed (e.g. CONFIG_ENCRYPTION_KEY rotated/missing).
      // Fall through to the env bootstrap rather than crashing the worker.
    }
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return {
      provider: process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER,
      model: process.env.LLM_MODEL ?? DEFAULT_MODEL,
      apiKey: envKey
    };
  }

  return null;
}

/**
 * Resolves the active config for the copilot — same provider/key as
 * {@link getActiveLlmConfig} but using the copilot model (DB `copilotModel`,
 * else env COPILOT_MODEL, else the strong default). Returns null when no key.
 */
export async function getActiveCopilotConfig(
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<ActiveLlmConfig | null> {
  const base = await getActiveLlmConfig(db);
  if (!base) {
    return null;
  }
  const row = await db.llmProviderConfig.findUnique({
    where: { id: "default" },
    select: { copilotModel: true }
  });
  const model = row?.copilotModel ?? process.env.COPILOT_MODEL ?? DEFAULT_COPILOT_MODEL;
  return { ...base, model };
}
