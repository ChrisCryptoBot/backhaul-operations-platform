import crypto from "node:crypto";
import { ParseState, Prisma, PrismaClient } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { IdempotencyConflictError } from "@/lib/idempotency-error";
import { evaluateDuplicatePolicy } from "@/domain/ingestion/duplicate-policy";
import { assertValidIngestionTransition } from "@/domain/ingestion/lifecycle";
import { workerOrchestratorAdapter } from "@/domain/workers/orchestrator-adapter";
import { withNonDeletedRegionScope } from "@/lib/scoped-query";
import { emitWorkerMetric } from "@/server/worker-metrics";

export function computeContentHash(fileBuffer: Buffer): string {
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

export async function finalizeUpload(input: {
  regionId: string;
  weekIso: string;
  sourceFileUrl: string;
  sourceFileHash: string;
  acceptedById?: string;
  idempotencyKey?: string;
  intakeDriverType?: "SHUTTLE" | "PTP" | "LTL";
  db?: PrismaClient | Prisma.TransactionClient;
  enqueueParseJob?: boolean;
  /**
   * Local/dev: run the parse synchronously via processQueueEnvelope instead of
   * enqueuing to SQS. Lets the whole pipeline run without AWS.
   */
  inlineProcessParse?: boolean;
}): Promise<{
  rateConfirmationId: string;
  duplicateKind: "NONE" | "EXACT_DUPLICATE" | "SOFT_DUPLICATE_WARNING";
  alreadyExisted: boolean;
}> {
  const { SQS_PARSE_QUEUE_URL } = getEnv();
  const db = input.db ?? prisma;
  const enqueueParseJob = input.enqueueParseJob ?? true;
  if (input.idempotencyKey) {
    const existingByIdempotency = await db.rateConfirmation.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });
    if (existingByIdempotency) {
      if (existingByIdempotency.sourceFileHash !== input.sourceFileHash) {
        throw new IdempotencyConflictError("Idempotency-Key conflict: payload hash differs from existing request");
      }
      return { rateConfirmationId: existingByIdempotency.id, duplicateKind: "EXACT_DUPLICATE", alreadyExisted: true };
    }
  }

  const existing = await db.rateConfirmation.findUnique({
    where: { sourceFileHash: input.sourceFileHash }
  });
  const softDuplicate = await db.rateConfirmation.findFirst({
    where: {
      regionId: input.regionId,
      weekIso: input.weekIso,
      sourceFileUrl: input.sourceFileUrl,
      deletedAt: null
    }
  });
  const duplicateResolution = evaluateDuplicatePolicy({
    hasExactHashDuplicate: Boolean(existing),
    hasSoftDuplicate: Boolean(softDuplicate && !existing)
  });
  if (duplicateResolution.kind === "EXACT_DUPLICATE" && existing) {
    return { rateConfirmationId: existing.id, duplicateKind: "EXACT_DUPLICATE", alreadyExisted: true };
  }

  const initialExtractedPayload: Prisma.InputJsonValue =
    duplicateResolution.kind === "SOFT_DUPLICATE_WARNING"
      ? ({ duplicateSignal: "SOFT_DUPLICATE_WARNING" } as Prisma.InputJsonValue)
      : (Prisma.JsonNull as unknown as Prisma.InputJsonValue);

  const rateConfirmation = await db.rateConfirmation.create({
    data: {
      regionId: input.regionId,
      weekIso: input.weekIso,
      sourceFileUrl: input.sourceFileUrl,
      sourceFileHash: input.sourceFileHash,
      idempotencyKey: input.idempotencyKey,
      parseState: ParseState.UPLOADED,
      duplicateSignal: duplicateResolution.kind === "SOFT_DUPLICATE_WARNING" ? "SOFT_DUPLICATE_WARNING" : null,
      intakeDriverType: input.intakeDriverType ?? null,
      extractedPayload: initialExtractedPayload
    }
  });

  if (input.acceptedById) {
    // Design note: reviewedAt/reviewedById capture upload acceptance intent here.
    // Review decisions can later overwrite these latest-state markers.
    // Full acceptance/decision timeline is preserved in AuditLog entries.
    await db.$executeRaw`UPDATE "RateConfirmation"
      SET "reviewedAt" = ${new Date()},
          "reviewedById" = ${input.acceptedById},
          "reviewReason" = NULL
      WHERE "id" = ${rateConfirmation.id}`;
    await db.auditLog.create({
      data: createAuditLog({
        entityType: "RateConfirmation",
        entityId: rateConfirmation.id,
        action: "UPLOAD_ACCEPTED",
        actorId: input.acceptedById,
        timestamp: new Date()
      })
    });
  }

  if (enqueueParseJob) {
    assertValidIngestionTransition(ParseState.UPLOADED, ParseState.QUEUED);
    await db.rateConfirmation.update({
      where: { id: rateConfirmation.id },
      data: { parseState: ParseState.QUEUED }
    });
    await db.auditLog.create({
      data: createAuditLog({
        entityType: "RateConfirmation",
        entityId: rateConfirmation.id,
        action: "STATE_TRANSITION",
        actorId: input.acceptedById ?? "system",
        timestamp: new Date(),
        afterValue: { from: ParseState.UPLOADED, to: ParseState.QUEUED }
      })
    });
    const parseJob = {
      regionId: input.regionId,
      weekIso: input.weekIso,
      entityId: rateConfirmation.id,
      eventType: "PARSE_RATE_CON" as const
    };
    if (input.inlineProcessParse) {
      // Dynamic import avoids the ingestion <-> queue-consumer require cycle.
      const { processQueueEnvelope } = await import("@/server/queue-consumer");
      const { queueEnvelopeVersion } = await import("@/contracts/queue");
      await processQueueEnvelope({ contractVersion: queueEnvelopeVersion, payload: parseJob }, db);
    } else {
      await workerOrchestratorAdapter.enqueue(SQS_PARSE_QUEUE_URL, parseJob);
    }
  }

  return {
    rateConfirmationId: rateConfirmation.id,
    duplicateKind: duplicateResolution.kind === "SOFT_DUPLICATE_WARNING" ? "SOFT_DUPLICATE_WARNING" : "NONE",
    alreadyExisted: false
  };
}

export function mapParseFailure(
  _confidence: number,
  code: "invalid" | "timeout" | "schema" | "low-confidence"
): ParseState {
  emitWorkerMetric({
    metric: "parse_failure_class",
    value: 1,
    tags: { code }
  });
  if (code === "invalid") {
    return ParseState.FAILED_INVALID;
  }
  if (code === "timeout") {
    return ParseState.FAILED_TIMEOUT;
  }
  if (code === "schema") {
    return ParseState.FAILED_SCHEMA;
  }
  return ParseState.FAILED_LOW_CONFIDENCE;
}

export async function markParseState(input: {
  rateConfirmationId: string;
  regionId: string;
  actorId: string;
  to: ParseState;
  db?: PrismaClient | Prisma.TransactionClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  const rc = await db.rateConfirmation.findFirst({
    where: withNonDeletedRegionScope(input.regionId, { id: input.rateConfirmationId })
  });
  if (!rc) {
    throw new Error("Rate confirmation not found for lifecycle transition.");
  }
  try {
    assertValidIngestionTransition(rc.parseState, input.to);
  } catch (error) {
    await db.auditLog.create({
      data: createAuditLog({
        entityType: "RateConfirmation",
        entityId: rc.id,
        action: "STATE_TRANSITION_REJECTED",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: error instanceof Error ? error.message : "Illegal transition",
        afterValue: { from: rc.parseState, to: input.to }
      })
    });
    throw error;
  }
  await db.rateConfirmation.update({
    where: { id: rc.id },
    data: { parseState: input.to }
  });
  await db.auditLog.create({
    data: createAuditLog({
      entityType: "RateConfirmation",
      entityId: rc.id,
      action: "STATE_TRANSITION",
      actorId: input.actorId,
      timestamp: new Date(),
      afterValue: { from: rc.parseState, to: input.to }
    })
  });
}
