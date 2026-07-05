import { Prisma } from "@prisma/client";

export interface LaneWeekMetadata {
  notes: Record<string, string>;
  // NOTE: historically named "marketRates" but semantically the manual TARGET-rate
  // override (KPI reads it as manualTargetRates). Kept as-is for back-compat.
  marketRates: Record<string, string>;
  // The true DAT market rate per lane (the external benchmark), distinct from the
  // target override above. Manual for now; the future DAT API writes here.
  datRates: Record<string, string>;
}

const EMPTY_METADATA: LaneWeekMetadata = {
  notes: {},
  marketRates: {},
  datRates: {}
};

function normalizeStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    output[key] = trimmed;
  }
  return output;
}

export function decodeLaneWeekMetadata(raw: unknown): LaneWeekMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_METADATA;
  }
  const record = raw as Record<string, unknown>;
  const hasV2Shape =
    Object.prototype.hasOwnProperty.call(record, "notes") ||
    Object.prototype.hasOwnProperty.call(record, "marketRates") ||
    Object.prototype.hasOwnProperty.call(record, "datRates");
  if (hasV2Shape) {
    return {
      notes: normalizeStringRecord(record.notes),
      marketRates: normalizeStringRecord(record.marketRates),
      datRates: normalizeStringRecord(record.datRates)
    };
  }
  // Legacy shape: field historically stored lane-note map only.
  return {
    notes: normalizeStringRecord(record),
    marketRates: {},
    datRates: {}
  };
}

export function encodeLaneWeekMetadata(input: Partial<LaneWeekMetadata>): Prisma.InputJsonValue {
  // Partial input: any omitted map normalizes to {}. Callers preserving other maps
  // should spread the decoded `current` (e.g. { ...current, notes }).
  return {
    notes: normalizeStringRecord(input.notes),
    marketRates: normalizeStringRecord(input.marketRates),
    datRates: normalizeStringRecord(input.datRates)
  } satisfies Prisma.InputJsonValue;
}
