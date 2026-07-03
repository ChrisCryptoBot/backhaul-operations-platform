/**
 * Shared taxonomy for a load's structured reference numbers (the numbers listed on
 * a rate con — PU#, PO#, BOL#, seal#, pro#, unlabeled → OTHER). Single source of
 * truth for the peek popover, the update-fields path, and (later) the copilot
 * classification + drawer. Mirrors the [[backhaul-ops-analytics-build]] disruptions
 * taxonomy pattern.
 */

export interface ReferenceNumberKindOption {
  value: string;
  label: string;
}

/** The suggested vocabulary of number kinds; anything else normalizes to OTHER. */
export const REFERENCE_NUMBER_KINDS: readonly ReferenceNumberKindOption[] = [
  { value: "PU", label: "Pickup #" },
  { value: "PO", label: "PO #" },
  { value: "BOL", label: "BOL #" },
  { value: "SEAL", label: "Seal #" },
  { value: "PRO", label: "PRO #" },
  { value: "ORDER", label: "Order #" },
  { value: "APPT", label: "Appt #" },
  { value: "REF", label: "Ref #" },
  { value: "CONTAINER", label: "Container #" },
  { value: "TRAILER", label: "Trailer #" },
  { value: "OTHER", label: "Other" }
] as const;

export const REFERENCE_NUMBER_KIND_VALUES: readonly string[] = REFERENCE_NUMBER_KINDS.map((k) => k.value);

const LABEL_BY_KIND = new Map<string, string>(REFERENCE_NUMBER_KINDS.map((k) => [k.value, k.label]));

export function referenceNumberKindLabel(kind: string): string {
  return LABEL_BY_KIND.get(kind) ?? kind;
}

export interface ReferenceNumber {
  kind: string;
  value: string;
  source?: "RATE_CON" | "MANUAL";
}

/** Guardrails so a bad/oversized payload can't bloat the JSON column. */
const MAX_REFERENCE_NUMBERS = 40;
const MAX_VALUE_LENGTH = 80;

function coerceKind(raw: unknown): string {
  if (typeof raw !== "string") return "OTHER";
  const upper = raw.trim().toUpperCase();
  return REFERENCE_NUMBER_KIND_VALUES.includes(upper) ? upper : "OTHER";
}

/**
 * Coerce arbitrary input (form state, JSON column, LLM output) into a clean, capped
 * list: drop entries with a blank value, clamp unknown kinds to OTHER, trim, cap count.
 */
export function normalizeReferenceNumbers(input: unknown): ReferenceNumber[] {
  if (!Array.isArray(input)) return [];
  const out: ReferenceNumber[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const value = typeof entry.value === "string" ? entry.value.trim().slice(0, MAX_VALUE_LENGTH) : "";
    if (!value) continue;
    const source = entry.source === "RATE_CON" || entry.source === "MANUAL" ? entry.source : undefined;
    out.push({ kind: coerceKind(entry.kind), value, ...(source ? { source } : {}) });
    if (out.length >= MAX_REFERENCE_NUMBERS) break;
  }
  return out;
}

/**
 * Project the PU-kind reference numbers back onto the legacy pickupNumber(s) fields so
 * the board cell display, checklist gate, and alerts keep working unchanged.
 */
export function derivePickupNumbers(refs: ReferenceNumber[]): { pickupNumber: string | null; pickupNumbers: string[] } {
  const pickups = refs.filter((r) => r.kind === "PU").map((r) => r.value);
  return { pickupNumber: pickups[0] ?? null, pickupNumbers: pickups };
}
