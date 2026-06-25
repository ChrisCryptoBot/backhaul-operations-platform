import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { prisma, runInRegionScope } from "@/lib/db";
import { resolvePhase1RegionId } from "@/lib/scope";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { todayIsoInTimeZone, isIsoDay } from "@/lib/board-date";
import { weekIsoFromPickup } from "@/lib/week";
import { computeContentHash, finalizeUpload } from "@/server/ingestion";
import { persistUploadedPdf } from "@/server/upload-storage";
import type { Role } from "@/lib/rbac";
import type Anthropic from "@anthropic-ai/sdk";
import { CopilotNotConfiguredError, executeConfirmedAction, runCopilotBrief, runCopilotTurn } from "@/server/copilot/agent";
import type { CopilotContext } from "@/server/copilot/tools";
import {
  advanceIntake,
  seedFromExtractedPayload,
  startIntake,
  type IntakeSeed,
  type IntakeState
} from "@/server/copilot/intake-interview";

const turnSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
    .max(40)
    .optional(),
  // Full prior Anthropic transcript for cross-turn memory; opaque + size-capped here, the agent treats it as messages.
  transcript: z.array(z.unknown()).max(200).optional(),
  regionId: z.string().min(1).optional(),
  date: z.string().optional()
});

const confirmSchema = z.object({
  confirm: z.object({ tool: z.string().min(1), input: z.record(z.string(), z.unknown()) }),
  regionId: z.string().min(1).optional(),
  date: z.string().optional()
});

const briefSchema = z.object({
  brief: z.literal(true),
  regionId: z.string().min(1).optional(),
  date: z.string().optional()
});

// Deterministic relay-load intake interview — no LLM, so it works at $0 credits.
// `state` absent → start; present → advance with `answer`.
const intakeSchema = z.object({
  intake: z.object({
    seed: z.record(z.string(), z.unknown()).optional(),
    state: z.unknown().optional(),
    answer: z.string().max(2000).optional()
  }),
  regionId: z.string().min(1).optional(),
  date: z.string().optional()
});

// Drop a rate con into the copilot: parse it inline, then start the intake
// interview seeded from the parsed payload. 32 MB cap on the base64 (~24 MB raw).
const ingestSchema = z.object({
  ingest: z.object({
    fileName: z.string().min(1).max(256),
    fileBase64: z.string().min(1).max(32 * 1024 * 1024)
  }),
  regionId: z.string().min(1).optional(),
  date: z.string().optional()
});

/**
 * Persist + inline-parse a dropped rate con, then return an intake interview
 * already seeded from the extracted payload and linked to the new rate con.
 * Mirrors the dev-only /api/internal/ingest-local pipeline but is auth-gated via
 * the caller's resolved context. `inlineProcessParse` runs the parser
 * synchronously (regex fallback at $0 LLM credits) so the seed is ready at once.
 */
async function ingestRateConfirmation(
  ctx: CopilotContext,
  file: { fileName: string; fileBase64: string }
) {
  const fileBuffer = Buffer.from(file.fileBase64, "base64");
  const sourceFileHash = computeContentHash(fileBuffer);
  const sourceFileUrl = `local://copilot/${ctx.boardDate}-${file.fileName}`;
  await persistUploadedPdf({ sourceFileUrl, sourceFileHash, fileBuffer });

  // The load's real pickupDate is collected later in the interview; the board
  // date only seeds the weekIso grouping for the rate-con row.
  const weekIso = weekIsoFromPickup(new Date(`${ctx.boardDate}T12:00:00.000Z`));
  const result = await runInRegionScope(ctx.regionId, async (tx) =>
    finalizeUpload({
      regionId: ctx.regionId,
      weekIso,
      sourceFileUrl,
      sourceFileHash,
      acceptedById: ctx.userId,
      db: tx,
      enqueueParseJob: true,
      inlineProcessParse: true
    })
  );

  // Ingestion is idempotent by content hash: re-dropping a rate con (or dropping
  // one already turned into a load via /review) resolves to the same row. That
  // row's load is one-to-one, so starting an intake would only 500 on confirm —
  // surface it plainly instead.
  const existingLoad = await prisma.load.findFirst({
    where: { rateConfirmationId: result.rateConfirmationId, deletedAt: null },
    select: { id: true }
  });
  if (existingLoad) {
    return {
      error: "That rate con already has a load — open it from the board instead of starting a new intake.",
      rateConfirmationId: result.rateConfirmationId,
      loadId: existingLoad.id
    };
  }

  const rc = await prisma.rateConfirmation.findUnique({
    where: { id: result.rateConfirmationId },
    select: { parseState: true, parseConfidence: true, extractedPayload: true }
  });

  const payload = (rc?.extractedPayload ?? {}) as Record<string, unknown>;
  const seed: IntakeSeed = {
    ...seedFromExtractedPayload(payload),
    rateConfirmationId: result.rateConfirmationId
  };
  // Human-readable "pre-filled from rate con" chips for the seeded-intake banner.
  const seedFields: Array<{ k: string; v: string }> = [];
  if (seed.pickupCity && seed.pickupState) seedFields.push({ k: "PU", v: `${seed.pickupCity}, ${seed.pickupState}` });
  if (seed.deliveryCity && seed.deliveryState) seedFields.push({ k: "DEL", v: `${seed.deliveryCity}, ${seed.deliveryState}` });
  if (seed.lineHaulRate) seedFields.push({ k: "Rate", v: `$${seed.lineHaulRate}` });
  if (seed.loadedMiles) seedFields.push({ k: "Miles", v: seed.loadedMiles });
  if (seed.brokerName) seedFields.push({ k: "Broker", v: seed.brokerName });
  return {
    ...startIntake(seed),
    rateConfirmationId: result.rateConfirmationId,
    parseState: rc?.parseState ?? null,
    parseConfidence: rc?.parseConfidence != null ? Number(rc.parseConfidence) : null,
    seedFields
  };
}

async function resolveContext(requestedRegionId: string | undefined, date: string | undefined): Promise<CopilotContext | NextResponse> {
  const { userId } = await auth();
  const bypass = isAuthBypassed();
  if (!bypass && !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let regionId = requestedRegionId?.trim() || "";
  if (!regionId) {
    regionId = bypass ? await resolvePhase1RegionId().catch(() => "dev-region") : await resolvePhase1RegionId();
  }

  let role: Role = "ADMIN";
  if (!bypass) {
    const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
    role = access.role;
  }

  return {
    userId: actorUserId,
    regionId,
    role,
    boardDate: isIsoDay(date) ? date : todayIsoInTimeZone()
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body && typeof body === "object" && "confirm" in body) {
      const payload = confirmSchema.parse(body);
      const ctx = await resolveContext(payload.regionId, payload.date);
      if (ctx instanceof NextResponse) return ctx;
      const result = await executeConfirmedAction(ctx, payload.confirm);
      return NextResponse.json(result, { status: 200 });
    }

    if (body && typeof body === "object" && "intake" in body) {
      const payload = intakeSchema.parse(body);
      // Resolve context to enforce auth / region access even though the
      // deterministic state machine itself needs no DB or LLM.
      const ctx = await resolveContext(payload.regionId, payload.date);
      if (ctx instanceof NextResponse) return ctx;
      const { intake } = payload;
      const result = intake.state
        ? advanceIntake(intake.state as IntakeState, intake.answer ?? "")
        : startIntake((intake.seed ?? {}) as IntakeSeed);
      return NextResponse.json(result, { status: 200 });
    }

    if (body && typeof body === "object" && "ingest" in body) {
      const payload = ingestSchema.parse(body);
      const ctx = await resolveContext(payload.regionId, payload.date);
      if (ctx instanceof NextResponse) return ctx;
      const result = await ingestRateConfirmation(ctx, payload.ingest);
      return NextResponse.json(result, { status: "error" in result ? 409 : 200 });
    }

    if (body && typeof body === "object" && "brief" in body) {
      const payload = briefSchema.parse(body);
      const ctx = await resolveContext(payload.regionId, payload.date);
      if (ctx instanceof NextResponse) return ctx;
      const result = await runCopilotBrief(ctx);
      return NextResponse.json(result, { status: 200 });
    }

    const payload = turnSchema.parse(body);
    const ctx = await resolveContext(payload.regionId, payload.date);
    if (ctx instanceof NextResponse) return ctx;
    const result = await runCopilotTurn(ctx, {
      message: payload.message,
      history: payload.history,
      transcript: payload.transcript as Anthropic.MessageParam[] | undefined
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof CopilotNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Copilot request failed." }, { status: 500 });
  }
}
