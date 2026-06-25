import type { ParserFailureCode, ParserResult } from "@/contracts/queue";

/**
 * Result of an LLM extraction attempt. Mirrors the shape returned by the
 * legacy regex parser (`parseRateConfirmationText`) so callers and downstream
 * handling remain identical regardless of which engine produced the result.
 */
export type LlmExtractionResult =
  | { ok: true; result: ParserResult }
  | { ok: false; code: ParserFailureCode; confidence: number };

export interface LlmExtractOptions {
  /** Decrypted API key for the provider. */
  apiKey: string;
  /** Model id (e.g. "claude-haiku-4-5"). */
  model: string;
}

/**
 * A pluggable LLM provider that extracts rate-confirmation fields from a PDF.
 * Implementations live under `providers/` and are registered in `registry.ts`.
 */
export interface LlmProvider {
  readonly name: string;
  extractRateConfirmation(pdf: Buffer, opts: LlmExtractOptions): Promise<LlmExtractionResult>;
}
