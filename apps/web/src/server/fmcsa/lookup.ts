import { authorityOf, FMCSA_BASE, noAuthority, normalizeMcNumber, parseFmcsaCarrier, type AuthorityResult } from "@/lib/fmcsa";

/**
 * Look a customer's MC number up at FMCSA, server side (the web key never reaches the browser). The answer is a reading for the dispatcher to
 * see: it is not stored and never stops a save. Every failure (no key, a timeout, a 429, a bad answer) reads as "unavailable", and only a
 * clean answer is remembered, so an outage clears itself.
 */
const TIMEOUT_MS = 8000;
const FOUND_MS = 60 * 60 * 1000;
const NOT_FOUND_MS = 5 * 60 * 1000;
const MEMORY_MAX = 300;
const memory = new Map<string, { at: number; result: AuthorityResult }>();

export const clearFmcsaMemory = () => memory.clear();

/** True when a web key is set, so a screen can say lookup is off rather than wrong. */
export const fmcsaConfigured = (): boolean => (process.env.FMCSA_WEBKEY ?? "").trim() !== "";

export async function lookupMc(mc: string, fetchImpl: typeof fetch = fetch, webKey: string = process.env.FMCSA_WEBKEY ?? ""): Promise<AuthorityResult> {
  const digits = normalizeMcNumber(mc);
  // An MC is a handful of digits; more than eight is a mistyped number or a phone number, and is not asked about.
  if (!digits || digits.length > 8) return noAuthority("not_found");
  const key = webKey.trim();
  if (!key) return noAuthority("unavailable");

  const hit = memory.get(digits);
  if (hit && Date.now() - hit.at < (hit.result.state === "not_found" ? NOT_FOUND_MS : FOUND_MS)) return hit.result;

  let json: unknown;
  try {
    const res = await fetchImpl(`${FMCSA_BASE}/docket-number/${encodeURIComponent(digits)}?webKey=${encodeURIComponent(key)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return noAuthority("unavailable");
    json = await res.json();
  } catch {
    return noAuthority("unavailable");
  }
  const carrier = parseFmcsaCarrier(json);
  const result = carrier ? authorityOf(carrier) : noAuthority("not_found");
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
  memory.set(digits, { at: Date.now(), result });
  return result;
}
