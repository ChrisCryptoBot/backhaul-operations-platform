import { ParseState, Prisma, PrismaClient } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { weekIsoFromPickup } from "@/lib/week";
import { stateToTimeZone, zonedDateTimeToUtc } from "@/lib/timezone";
import { runInRegionScope } from "@/lib/db";
import { ReviewConflictError, ReviewNotFoundError, ReviewValidationError } from "@/lib/review-errors";
import { computeLoadMetrics } from "./kpi";
import { workerOrchestratorAdapter } from "@/domain/workers/orchestrator-adapter";
import { reviewContractVersion } from "@/contracts/review";

type ReviewDecisionState = "PENDING" | "APPROVED" | "REJECTED";

export interface CreateLoadInput {
  actorId: string;
  regionId: string;
  rateConfirmationId?: string | null;
  brokerId?: string;
  pickupDate: Date;
  deliveryDate?: Date | null;
  bookingDate?: Date;
  dropLotId?: string;
  shipperName?: string;
  receiverName?: string;
  lineHaulRate: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
  fscApplies: boolean;
  driverType?: "SHUTTLE" | "PTP" | "LTL";
  pickupApptType?: AppointmentType | null;
  pickupWindowStart?: Date | null;
  pickupWindowEnd?: Date | null;
  pickupTimeZone?: string | null;
  deliveryApptType?: AppointmentType | null;
  deliveryWindowStart?: Date | null;
  deliveryWindowEnd?: Date | null;
  deliveryTimeZone?: string | null;
}

type AppointmentType = "FIRM_APPT" | "OPEN_WINDOW" | "FCFS";

interface ResolvedAppointment {
  apptType: AppointmentType | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  timeZone: string | null;
}

function parseStateFromCityState(cityState: string | null): string | null {
  if (!cityState) return null;
  const parts = cityState.split(",");
  const tail = parts[parts.length - 1]?.trim().toUpperCase();
  return tail && /^[A-Z]{2}$/.test(tail) ? tail : null;
}

/**
 * Resolve one stop's structured appointment from the extracted payload: the
 * FIRM/OPEN/FCFS type plus UTC window timestamps derived from the local HH:MM
 * times and the stop's timezone (from its city/state).
 */
function resolveAppointment(
  payload: Record<string, unknown>,
  keys: { isoDate: string; apptType: string; start: string; end: string; cityState: string }
): ResolvedAppointment {
  const str = (key: string): string | null => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const rawType = str(keys.apptType);
  const apptType: AppointmentType | null =
    rawType === "FIRM_APPT" || rawType === "OPEN_WINDOW" || rawType === "FCFS" ? rawType : null;
  const isoDate = str(keys.isoDate);
  const state = parseStateFromCityState(str(keys.cityState));
  const timeZone = state ? stateToTimeZone(state) : null;
  const start = str(keys.start);
  const end = str(keys.end);
  // A half-specified window (one of start/end, or unresolvable date/tz) is dropped
  // entirely below — surface it so a partial extraction isn't silently lost.
  if (Boolean(start) !== Boolean(end) || ((start || end) && (!isoDate || !timeZone))) {
    // eslint-disable-next-line no-console
    console.warn(
      `[review] dropping partial appointment window (${keys.start}/${keys.end}): start=${start ?? "—"} end=${end ?? "—"} date=${isoDate ?? "—"} tz=${timeZone ?? "—"}`
    );
  }
  const windowStart = isoDate && start && timeZone ? zonedDateTimeToUtc(isoDate, start, timeZone) : null;
  const windowEnd = isoDate && end && timeZone ? zonedDateTimeToUtc(isoDate, end, timeZone) : null;
  return { apptType, windowStart, windowEnd, timeZone: windowStart || windowEnd ? timeZone : null };
}

export interface ReviewRateConfirmation {
  contractVersion: string;
  id: string;
  parseState: string;
  reviewDecision: ReviewDecisionState;
  sourceFileUrl: string;
  extractedPayload: Record<string, unknown> | null;
  parseConfidence: number | null;
  loadId: string | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewReason: string | null;
  intakeDriverType?: "SHUTTLE" | "PTP" | "LTL" | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManualLoadInput {
  actorId: string;
  regionId: string;
  pickupDate: Date;
  deliveryDate?: Date | null;
  shipperName?: string;
  receiverName?: string;
  brokerId?: string;
  dropLotId?: string;
  lineHaulRate: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
  fscApplies: boolean;
  driverType?: "SHUTTLE" | "PTP" | "LTL";
  /** Link the born load back to the rate con it was ingested from (else null). */
  rateConfirmationId?: string | null;
}

export async function getRateConfirmationForReview(input: {
  regionId: string;
  rateConfirmationId: string;
  db?: PrismaClient | Prisma.TransactionClient;
}): Promise<ReviewRateConfirmation | null> {
  const db = input.db ?? prisma;
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      parseState: ParseState;
      reviewDecision: ReviewDecisionState;
      sourceFileUrl: string;
      extractedPayload: Prisma.JsonValue | null;
      parseConfidence: Prisma.Decimal | null;
      reviewedAt: Date | null;
      reviewedById: string | null;
      reviewReason: string | null;
      intakeDriverType: "SHUTTLE" | "PTP" | "LTL" | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`SELECT "id", "parseState", "reviewDecision", "sourceFileUrl", "extractedPayload", "parseConfidence", "reviewedAt", "reviewedById", "reviewReason", "intakeDriverType", "createdAt", "updatedAt"
    FROM "RateConfirmation"
    WHERE "id" = ${input.rateConfirmationId}
      AND "regionId" = ${input.regionId}
      AND "deletedAt" IS NULL
    LIMIT 1`;
  const rc = rows[0] ?? null;
  if (!rc) {
    return null;
  }
  const load = await db.load.findFirst({
    where: { rateConfirmationId: rc.id },
    select: { id: true }
  });
  return {
    contractVersion: reviewContractVersion,
    id: rc.id,
    parseState: rc.parseState,
    reviewDecision: rc.reviewDecision,
    sourceFileUrl: rc.sourceFileUrl,
    extractedPayload: (rc.extractedPayload ?? null) as Record<string, unknown> | null,
    parseConfidence: rc.parseConfidence ? new Prisma.Decimal(rc.parseConfidence).toNumber() : null,
    loadId: load?.id ?? null,
    reviewedAt: rc.reviewedAt?.toISOString() ?? null,
    reviewedById: rc.reviewedById,
    reviewReason: rc.reviewReason,
    intakeDriverType: rc.intakeDriverType,
    createdAt: rc.createdAt.toISOString(),
    updatedAt: rc.updatedAt.toISOString()
  };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function readPickupDate(record: Record<string, unknown>): Date {
  const candidates = ["pickupDate", "puDate"];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  throw new ReviewValidationError("Missing or invalid pickupDate in extracted payload.");
}

function readOptionalDate(record: Record<string, unknown>, key: string): Date | null {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function readRequiredDecimal(record: Record<string, unknown>, key: string): Prisma.Decimal {
  const value = record[key];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ReviewValidationError(`Missing ${key} in extracted payload.`);
  }
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value);
  } catch {
    throw new ReviewValidationError(`Invalid ${key} in extracted payload.`);
  }
  // Required money/miles must be strictly positive — a $0/negative load is nonsense
  // (mirrors the manual-entry .positive() guard). Catches bad LLM extractions.
  if (decimal.lessThanOrEqualTo(0)) {
    throw new ReviewValidationError(`${key} must be greater than zero (got ${decimal.toString()}).`);
  }
  return decimal;
}

function readOptionalDecimal(record: Record<string, unknown>, key: string, fallback = "0"): Prisma.Decimal {
  const value = record[key];
  if (typeof value === "number" || typeof value === "string") {
    let decimal: Prisma.Decimal;
    try {
      decimal = new Prisma.Decimal(value);
    } catch {
      return new Prisma.Decimal(fallback);
    }
    // Negative deadhead/optional miles are invalid (manual entry uses .min(0)).
    if (decimal.lessThan(0)) {
      throw new ReviewValidationError(`${key} cannot be negative (got ${decimal.toString()}).`);
    }
    return decimal;
  }
  return new Prisma.Decimal(fallback);
}

function readDriverType(record: Record<string, unknown>, key: string): "SHUTTLE" | "PTP" | "LTL" | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === "SHUTTLE" || normalized === "PTP" || normalized === "LTL") {
    return normalized;
  }
  return undefined;
}

export function mapExtractedPayloadToCreateLoadInput(input: {
  actorId: string;
  regionId: string;
  rateConfirmationId: string;
  intakeDriverType?: "SHUTTLE" | "PTP" | "LTL" | null;
  brokerId?: string;
  extractedPayload: Record<string, unknown>;
}): CreateLoadInput {
  const pickupAppt = resolveAppointment(input.extractedPayload, {
    isoDate: "pickupDate",
    apptType: "pickupApptType",
    start: "pickupWindowStart",
    end: "pickupWindowEnd",
    cityState: "originCityState"
  });
  const deliveryAppt = resolveAppointment(input.extractedPayload, {
    isoDate: "deliveryDate",
    apptType: "deliveryApptType",
    start: "deliveryWindowStart",
    end: "deliveryWindowEnd",
    cityState: "destinationCityState"
  });
  return {
    actorId: input.actorId,
    regionId: input.regionId,
    rateConfirmationId: input.rateConfirmationId,
    brokerId: input.brokerId,
    pickupDate: readPickupDate(input.extractedPayload),
    deliveryDate: readOptionalDate(input.extractedPayload, "deliveryDate"),
    bookingDate: new Date(),
    shipperName: readString(input.extractedPayload, "shipperName") ?? undefined,
    receiverName: readString(input.extractedPayload, "receiverName") ?? undefined,
    lineHaulRate: readRequiredDecimal(input.extractedPayload, "lineHaulRate"),
    loadedMiles: readRequiredDecimal(input.extractedPayload, "loadedMiles"),
    puDeadheadMiles: readOptionalDecimal(input.extractedPayload, "puDeadheadMiles"),
    delDeadheadMiles: readOptionalDecimal(input.extractedPayload, "delDeadheadMiles"),
    fscApplies: readBoolean(input.extractedPayload, "fscApplies", false),
    driverType: readDriverType(input.extractedPayload, "driverType") ?? input.intakeDriverType ?? undefined,
    pickupApptType: pickupAppt.apptType,
    pickupWindowStart: pickupAppt.windowStart,
    pickupWindowEnd: pickupAppt.windowEnd,
    pickupTimeZone: pickupAppt.timeZone,
    deliveryApptType: deliveryAppt.apptType,
    deliveryWindowStart: deliveryAppt.windowStart,
    deliveryWindowEnd: deliveryAppt.windowEnd,
    deliveryTimeZone: deliveryAppt.timeZone
  };
}

export async function approveRateConfirmationReview(input: {
  actorId: string;
  regionId: string;
  rateConfirmationId: string;
}): Promise<{ loadId: string; alreadyExisted: boolean }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const rc = await getRateConfirmationForReview({
      db: tx,
      regionId: input.regionId,
      rateConfirmationId: input.rateConfirmationId
    });
    if (!rc) {
      throw new ReviewNotFoundError("Rate confirmation not found.");
    }
    if (rc.reviewDecision === "REJECTED") {
      throw new ReviewConflictError("Rate confirmation is marked as rejected.");
    }
    if (rc.loadId) {
      return { loadId: rc.loadId, alreadyExisted: true };
    }
    if (rc.parseState !== ParseState.EXTRACTED) {
      throw new ReviewConflictError("Rate confirmation is not ready for approval.");
    }

    const extracted = rc.extractedPayload ?? {};
    const brokerName = readString(extracted, "brokerName");
    const broker =
      brokerName === null
        ? null
        : await tx.broker.findFirst({
            where: {
              regionId: input.regionId,
              deletedAt: null,
              name: { equals: brokerName, mode: "insensitive" }
            },
            select: { id: true }
          });

    // A broker name was extracted but didn't match any region broker — leave a
    // trace (the load gets a null brokerId) so it can be reconciled, not silently lost.
    if (brokerName !== null && broker === null) {
      await tx.auditLog.create({
        data: createAuditLog({
          entityType: "RateConfirmation",
          entityId: rc.id,
          action: "BROKER_UNMATCHED",
          actorId: input.actorId,
          timestamp: new Date(),
          afterValue: { brokerName }
        })
      });
    }

    const loadInput = mapExtractedPayloadToCreateLoadInput({
      actorId: input.actorId,
      regionId: input.regionId,
      rateConfirmationId: rc.id,
      intakeDriverType: rc.intakeDriverType,
      brokerId: broker?.id,
      extractedPayload: extracted
    });
    const result = await createLoadFromReview(loadInput, tx);
    // Design note: reviewedAt/reviewedById represent latest decision metadata.
    // Upload-time acceptance may have set these fields earlier; AuditLog stores full event history.
    await tx.$executeRaw`UPDATE "RateConfirmation"
      SET "reviewDecision" = 'APPROVED'::"ReviewDecision",
          "reviewedAt" = ${new Date()},
          "reviewedById" = ${input.actorId},
          "reviewReason" = NULL
      WHERE "id" = ${rc.id}`;
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "RateConfirmation",
        entityId: rc.id,
        action: "CONFIRM_REVIEW",
        actorId: input.actorId,
        timestamp: new Date(),
        afterValue: {
          loadId: result.loadId
        }
      })
    });
    return { loadId: result.loadId, alreadyExisted: false };
  });
}

export async function rejectRateConfirmationReview(input: {
  actorId: string;
  regionId: string;
  rateConfirmationId: string;
  reason?: string | null;
}): Promise<{ reviewDecision: ReviewDecisionState }> {
  return runInRegionScope(input.regionId, async (tx) => {
    const rc = await getRateConfirmationForReview({
      db: tx,
      regionId: input.regionId,
      rateConfirmationId: input.rateConfirmationId
    });
    if (!rc) {
      throw new ReviewNotFoundError("Rate confirmation not found.");
    }
    if (rc.loadId) {
      throw new ReviewConflictError("Rate confirmation already linked to a load.");
    }
    await tx.$executeRaw`UPDATE "RateConfirmation"
      SET "reviewDecision" = 'REJECTED'::"ReviewDecision",
          "reviewedAt" = ${new Date()},
          "reviewedById" = ${input.actorId},
          "reviewReason" = ${input.reason ?? null}
      WHERE "id" = ${rc.id}`;
    await tx.auditLog.create({
      data: createAuditLog({
        entityType: "RateConfirmation",
        entityId: rc.id,
        action: "REJECT_REVIEW",
        actorId: input.actorId,
        timestamp: new Date(),
        reason: input.reason ?? undefined
      })
    });
    return { reviewDecision: "REJECTED" };
  });
}

export async function createLoadFromReview(
  input: CreateLoadInput,
  db: Prisma.TransactionClient | PrismaClient = prisma
): Promise<{ loadId: string }> {
  const { SQS_RECOMPUTE_QUEUE_URL } = getEnv();
  const derivedWeekIso = weekIsoFromPickup(input.pickupDate);
  // FSC parked (spot-broker-first): never apply FSC or require a Tuesday FSC index. The
  // fscApplies/fscRateUsed columns are kept dormant for a future direct-3PL re-add.
  const fscApplies = false;
  const resolvedFscRate: Prisma.Decimal | null = null;
  const metrics = computeLoadMetrics({
    lineHaulRate: input.lineHaulRate,
    loadedMiles: input.loadedMiles,
    puDeadheadMiles: input.puDeadheadMiles,
    delDeadheadMiles: input.delDeadheadMiles,
    fscApplies,
    fscRateUsed: resolvedFscRate
  });

  // NOTE: Prisma types imported from @prisma/client can lag this repo's custom
  // generator output path during local typecheck. Keep this narrow cast at the
  // DB boundary instead of broad `as never` usage in callers/tests.
  const loadCreateData = {
    regionId: input.regionId,
    weekIso: derivedWeekIso,
    pickupDate: input.pickupDate,
    deliveryDate: input.deliveryDate ?? null,
    status: "BOOKED",
    createdById: input.actorId,
    bookingDate: input.bookingDate ?? input.pickupDate,
    dropLotId: input.dropLotId,
    shipperName: input.shipperName,
    receiverName: input.receiverName,
    brokerId: input.brokerId,
    rateConfirmationId: input.rateConfirmationId ?? null,
    pickupNumbers: [],
    lineHaulRate: input.lineHaulRate,
    loadedMiles: input.loadedMiles,
    puDeadheadMiles: input.puDeadheadMiles,
    delDeadheadMiles: input.delDeadheadMiles,
    fscApplies,
    fscRateUsed: resolvedFscRate,
    fscAmount: metrics.fscAmount,
    allInRevenue: metrics.allInRevenue,
    totalTripMiles: metrics.totalTripMiles,
    negotiableMiles: metrics.negotiableMiles,
    loadedRpm: metrics.loadedRpm,
    emptyMilePct: metrics.emptyMilePct,
    driverType: input.driverType,
    pickupApptType: input.pickupApptType ?? null,
    pickupWindowStart: input.pickupWindowStart ?? null,
    pickupWindowEnd: input.pickupWindowEnd ?? null,
    pickupTimeZone: input.pickupTimeZone ?? null,
    deliveryApptType: input.deliveryApptType ?? null,
    deliveryWindowStart: input.deliveryWindowStart ?? null,
    deliveryWindowEnd: input.deliveryWindowEnd ?? null,
    deliveryTimeZone: input.deliveryTimeZone ?? null
  } as Prisma.LoadUncheckedCreateInput;

  const load = await db.load.create({
    data: loadCreateData
  });

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "Load",
      entityId: load.id,
      action: "CREATE",
      actorId: input.actorId,
      timestamp: new Date(),
      afterValue: {
        regionId: input.regionId,
        weekIso: derivedWeekIso
      }
    })
  });

  await workerOrchestratorAdapter.enqueue(SQS_RECOMPUTE_QUEUE_URL, {
    regionId: input.regionId,
    weekIso: derivedWeekIso,
    entityId: load.id,
    eventType: "RECOMPUTE_WEEK_SNAPSHOT"
  });

  return { loadId: load.id };
}

export async function createManualLoad(input: ManualLoadInput): Promise<{ loadId: string }> {
  return runInRegionScope(input.regionId, async (tx) =>
    createLoadFromReview(
      {
        actorId: input.actorId,
        regionId: input.regionId,
        rateConfirmationId: input.rateConfirmationId ?? null,
        pickupDate: input.pickupDate,
        deliveryDate: input.deliveryDate ?? null,
        bookingDate: input.pickupDate,
        shipperName: input.shipperName,
        receiverName: input.receiverName,
        brokerId: input.brokerId,
        dropLotId: input.dropLotId,
        lineHaulRate: input.lineHaulRate,
        loadedMiles: input.loadedMiles,
        puDeadheadMiles: input.puDeadheadMiles,
        delDeadheadMiles: input.delDeadheadMiles,
        fscApplies: input.fscApplies,
        driverType: input.driverType
      },
      tx
    )
  );
}
