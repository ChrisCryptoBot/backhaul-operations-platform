import { Prisma, type DisruptionKind, type DisruptionReason } from "@prisma/client";
import { disruptionDetailRequired } from "@/lib/disruptions";

/** A disruption write rejected for missing required input (vs a server fault). */
export class DisruptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisruptionValidationError";
  }
}

export interface RecordLoadDisruptionInput {
  loadId: string;
  regionId: string;
  /** Denormalized at write so the KPI breakdown groups without re-deriving it. */
  weekIso: string;
  kind: DisruptionKind;
  reason: DisruptionReason;
  detail?: string | null;
  actorId: string;
}

/**
 * Record a cancel/reschedule disruption event inside the SAME transaction as the
 * status/reschedule update that caused it. Requires a non-empty `detail` when the
 * reason is OTHER so the free-text carries the "why".
 */
export async function recordLoadDisruption(
  tx: Prisma.TransactionClient,
  input: RecordLoadDisruptionInput
): Promise<void> {
  const detail = input.detail?.trim() ? input.detail.trim() : null;
  if (disruptionDetailRequired(input.reason) && !detail) {
    throw new DisruptionValidationError("A detail is required when the reason is Other.");
  }
  await tx.loadDisruptionEvent.create({
    data: {
      loadId: input.loadId,
      regionId: input.regionId,
      weekIso: input.weekIso,
      kind: input.kind,
      reason: input.reason,
      detail,
      actorId: input.actorId
    }
  });
}
