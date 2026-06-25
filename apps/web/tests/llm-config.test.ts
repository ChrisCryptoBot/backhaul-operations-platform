import { afterEach, beforeEach, describe, expect, test } from "vitest";
import crypto from "node:crypto";
import { getActiveLlmConfig } from "@/server/llm/config";
import { encryptSecret } from "@/lib/crypto-config";

type FakeDb = { llmProviderConfig: { findUnique: () => Promise<unknown> } };

function dbReturning(row: unknown): FakeDb {
  return { llmProviderConfig: { findUnique: async () => row } };
}

const ENV_KEYS = ["CONFIG_ENCRYPTION_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER", "LLM_MODEL"] as const;
const original: Record<string, string | undefined> = {};

describe("getActiveLlmConfig", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  test("returns null when no DB row and no env key", async () => {
    const result = await getActiveLlmConfig(dbReturning(null) as never);
    expect(result).toBeNull();
  });

  test("falls back to env bootstrap when no DB row", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_MODEL = "claude-haiku-4-5";
    const result = await getActiveLlmConfig(dbReturning(null) as never);
    expect(result).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", apiKey: "env-key" });
  });

  test("prefers the active DB row and decrypts the key", async () => {
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    const cipher = encryptSecret("db-secret-key");
    const result = await getActiveLlmConfig(
      dbReturning({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKeyCipher: cipher,
        isActive: true
      }) as never
    );
    expect(result).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "db-secret-key" });
  });

  test("ignores an inactive DB row and falls back to env", async () => {
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    process.env.ANTHROPIC_API_KEY = "env-key";
    const cipher = encryptSecret("db-secret-key");
    const result = await getActiveLlmConfig(
      dbReturning({ provider: "anthropic", model: "claude-opus-4-8", apiKeyCipher: cipher, isActive: false }) as never
    );
    expect(result?.apiKey).toBe("env-key");
  });
});
