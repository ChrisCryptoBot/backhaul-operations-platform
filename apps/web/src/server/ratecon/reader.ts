import Anthropic from "@anthropic-ai/sdk";
import { buildExtractionParams, isSupportedMime, normalizeExtraction, readExtraction } from "@/truelane/rate-con/core";
import { DEMO_RATE_CON_READINGS } from "./fixtures";
import { extractionToLoadDraft, type RateConLoadDraft } from "./map";

/**
 * Reads a rate confirmation into a load draft. Two paths:
 *  - a demo file name (RC-AFB-482913...) returns the canned reading: no key, no network, same normalizer;
 *  - anything else calls the model with TrueLane's schema and prompt, only when ANTHROPIC_API_KEY is set.
 * The draft is never saved here. A person reviews it first (see ./save.ts).
 *
 * The live path mirrors TrueLane's supabase/functions/rate-con-extract/index.ts (same params, same SDK call) but has not
 * been run from this app: it needs a key. Until it has been, treat it as unverified.
 */
export type ReadInput = { fileName: string; mime?: string; bytes?: Uint8Array };

export type ReadOutcome =
  | { ok: true; source: "demo" | "live"; draft: RateConLoadDraft }
  | { ok: false; reason: "no_key" | "unsupported_file" | "unreadable" | "refused" | "upstream_error" };

export function demoKeyOf(fileName: string): string | null {
  const m = /RC-[A-Z]+-\d+/.exec(fileName.toUpperCase());
  return m && DEMO_RATE_CON_READINGS[m[0]] ? m[0] : null;
}

export async function readRateCon(input: ReadInput, env: { ANTHROPIC_API_KEY?: string | undefined } = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }): Promise<ReadOutcome> {
  const demo = demoKeyOf(input.fileName);
  if (demo) {
    const draft = extractionToLoadDraft(normalizeExtraction(DEMO_RATE_CON_READINGS[demo]!));
    return draft ? { ok: true, source: "demo", draft } : { ok: false, reason: "unreadable" };
  }
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "no_key" };
  if (!input.bytes || !isSupportedMime(input.mime)) return { ok: false, reason: "unsupported_file" };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const params = buildExtractionParams(input.mime, Buffer.from(input.bytes).toString("base64"));
  try {
    // The SDK version here predates the fallbacks/betas fields; the call shape is TrueLane's.
    const res = await (client.beta.messages as unknown as { create: (p: unknown) => Promise<unknown> }).create(params);
    const read = readExtraction(res as Parameters<typeof readExtraction>[0]);
    if (!read.ok) return { ok: false, reason: read.reason === "refusal" ? "refused" : "unreadable" };
    const draft = extractionToLoadDraft(normalizeExtraction(read.extraction));
    return draft ? { ok: true, source: "live", draft } : { ok: false, reason: "unreadable" };
  } catch {
    return { ok: false, reason: "upstream_error" };
  }
}
