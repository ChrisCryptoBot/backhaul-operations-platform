import { Prisma } from "@prisma/client";

export interface LaneWeekMetadata {
  notes: Record<string, string>;
  marketRates: Record<string, string>;
}

const EMPTY_METADATA: LaneWeekMetadata = {
  notes: {},
  marketRates: {}
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
  const hasV2Shape = Object.prototype.hasOwnProperty.call(record, "notes") || Object.prototype.hasOwnProperty.call(record, "marketRates");
  if (hasV2Shape) {
    return {
      notes: normalizeStringRecord(record.notes),
      marketRates: normalizeStringRecord(record.marketRates)
    };
  }
  // Legacy shape: field historically stored lane-note map only.
  return {
    notes: normalizeStringRecord(record),
    marketRates: {}
  };
}

export function encodeLaneWeekMetadata(input: LaneWeekMetadata): Prisma.InputJsonValue {
  return {
    notes: normalizeStringRecord(input.notes),
    marketRates: normalizeStringRecord(input.marketRates)
  } satisfies Prisma.InputJsonValue;
}
