import { ParseState } from "@prisma/client";

export type IngestionLifecycleState = ParseState;

const allowedTransitions: Record<IngestionLifecycleState, Set<IngestionLifecycleState>> = {
  UPLOADED: new Set(["QUEUED"]),
  QUEUED: new Set(["EXTRACTED", "FAILED_INVALID", "FAILED_TIMEOUT", "FAILED_SCHEMA", "FAILED_LOW_CONFIDENCE"]),
  EXTRACTED: new Set([]),
  FAILED_INVALID: new Set([]),
  FAILED_TIMEOUT: new Set([]),
  FAILED_SCHEMA: new Set([]),
  FAILED_LOW_CONFIDENCE: new Set([])
};

export function assertValidIngestionTransition(from: IngestionLifecycleState, to: IngestionLifecycleState): void {
  if (from === to) return;
  if (!allowedTransitions[from]?.has(to)) {
    throw new Error(`Illegal ingestion lifecycle transition: ${from} -> ${to}`);
  }
}

