import { ParseState, Prisma, PrismaClient } from "@prisma/client";
import { queueEnvelopeSchema, type QueueEnvelope } from "@/contracts/queue";
import { prisma } from "@/lib/db";
import { mapParseFailure, markParseState } from "@/server/ingestion";
import { readUploadedPdf } from "@/server/upload-storage";
import { recomputeWeekSnapshot } from "@/server/snapshots";
import { createAuditLog } from "@/lib/audit";
import { parseRateConfirmation } from "@/server/parser-engine";

export async function processQueueEnvelope(
  raw: unknown,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<void> {
  const envelope: QueueEnvelope = queueEnvelopeSchema.parse(raw);
  const payload = envelope.payload;

  if (payload.eventType === "RECOMPUTE_WEEK_SNAPSHOT") {
    await recomputeWeekSnapshot(payload.regionId, payload.weekIso, "worker-system", db);
    return;
  }

  const rc = await db.rateConfirmation.findFirst({
    where: {
      id: payload.entityId,
      regionId: payload.regionId,
      deletedAt: null
    }
  });
  if (!rc) {
    return;
  }

  try {
    if (rc.parseState !== ParseState.QUEUED) {
      await markParseState({
        rateConfirmationId: rc.id,
        regionId: rc.regionId,
        actorId: "worker-system",
        to: ParseState.QUEUED,
        db
      });
    }

    const buffer = await readUploadedPdf({ sourceFileHash: rc.sourceFileHash, sourceFileUrl: rc.sourceFileUrl });
    const parsed = await parseRateConfirmation(buffer);
    if (!parsed.ok) {
      const failureState = mapParseFailure(parsed.confidence, parsed.code);
      await markParseState({
        rateConfirmationId: rc.id,
        regionId: rc.regionId,
        actorId: "worker-system",
        to: failureState,
        db
      });
      await db.auditLog.create({
        data: createAuditLog({
          entityType: "RateConfirmation",
          entityId: rc.id,
          action: "PARSE_FAILURE_RECORDED",
          actorId: "worker-system",
          timestamp: new Date(),
          reason: `Parser failure: ${parsed.code}`
        })
      });
      return;
    }

    const extractedPayload: Prisma.InputJsonValue = {
      ...parsed.result.extractedPayload,
      parserVersion: parsed.result.parserVersion
    } as Prisma.InputJsonValue;
    await db.rateConfirmation.update({
      where: { id: rc.id },
      data: {
        parseConfidence: new Prisma.Decimal(parsed.result.confidence.toFixed(4)),
        extractedPayload,
        reviewDecision: "PENDING"
      }
    });
    await markParseState({
      rateConfirmationId: rc.id,
      regionId: rc.regionId,
      actorId: "worker-system",
      to: ParseState.EXTRACTED,
      db
    });
  } catch (error) {
    const failureState = mapParseFailure(0, "schema");
    try {
      await markParseState({
        rateConfirmationId: rc.id,
        regionId: rc.regionId,
        actorId: "worker-system",
        to: failureState,
        db
      });
    } catch {
      await db.auditLog.create({
        data: createAuditLog({
          entityType: "RateConfirmation",
          entityId: rc.id,
          action: "PARSE_FAILURE_RECORDED",
          actorId: "worker-system",
          timestamp: new Date(),
          reason: error instanceof Error ? error.message : "parse failure"
        })
      });
    }
  }
}

