import type { LlmProvider } from "@/server/llm/types";
import { anthropicProvider } from "@/server/llm/providers/anthropic";

/**
 * Registered LLM providers, keyed by the `provider` string stored in
 * LlmProviderConfig. Only Anthropic is implemented today; adding another
 * provider is a drop-in: implement the LlmProvider interface and register it
 * here. The Settings UI lists unregistered providers as "coming soon".
 */
const providers: Record<string, LlmProvider> = {
  anthropic: anthropicProvider
};

/** Provider ids selectable in the Settings UI (active = registered here). */
export const SUPPORTED_PROVIDERS = Object.keys(providers);

export function getProvider(name: string): LlmProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unsupported LLM provider: ${name}`);
  }
  return provider;
}
