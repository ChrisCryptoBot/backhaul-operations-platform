import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, runInRegionScope } from "@/lib/db";
import { isAwsConfigured } from "@/lib/env";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { weekIsoFromPickup } from "@/lib/week";
import { persistUploadedPdf } from "@/server/upload-storage";
import { computeContentHash, finalizeUpload } from "@/server/ingestion";
import { approveRateConfirmationReview } from "@/server/review";

// DEV-ONLY local ingestion: runs the real pipeline (persist -> inline parse ->
// optional approve -> Load) on a filesystem-stored file, bypassing S3/SQS.
// Used by scripts/ingest-local.mjs to battle-test ingestion without AWS.

const schema = z.object({
  fileName: z.string().min(1),
  fileBase64: z.string().min(1),
  regionId: z.string().min(1).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  intakeDriverType: z.enum(["SHUTTLE", "PTP", "LTL"]).optional(),
  autoApprove: z.boolean().optional()
});

export async function POST(request: Request) {
  // Only available locally: no AWS configured AND auth bypass on.
  if (isAwsConfigured() || !isAuthBypassed()) {
    return NextResponse.json(
      { error: "Local ingest is only available in local/dev (no AWS + auth bypass)." },
      { status: 403 }
    );
  }
  try {
    const body = schema.parse(await request.json());
    const regionId = body.regionId ?? (await resolvePhase1RegionId());
    const fileBuffer = Buffer.from(body.fileBase64, "base64");
    const sourceFileHash = computeContentHash(fileBuffer);
    // Non-S3 URL -> persist/read fall back to the local .uploads/ store.
    const sourceFileUrl = `local://uploads/${Date.now()}-${body.fileName}`;
    await persistUploadedPdf({ sourceFileUrl, sourceFileHash, fileBuffer });

    const weekIso = weekIsoFromPickup(new Date(`${body.pickupDate}T12:00:00.000Z`));
    const result = await runInRegionScope(regionId, async (tx) =>
      finalizeUpload({
        regionId,
        weekIso,
        sourceFileUrl,
        sourceFileHash,
        acceptedById: "dev-bypass-user",
        intakeDriverType: body.intakeDriverType,
        db: tx,
        enqueueParseJob: true,
        inlineProcessParse: true
      })
    );

    const rc = await prisma.rateConfirmation.findUnique({
      where: { id: result.rateConfirmationId },
      select: { parseState: true, parseConfidence: true, extractedPayload: true }
    });

    let loadId: string | null = null;
    let approveError: string | null = null;
    if (body.autoApprove !== false && rc?.parseState === "EXTRACTED") {
      try {
        const approved = await approveRateConfirmationReview({
          actorId: "dev-bypass-user",
          regionId,
          rateConfirmationId: result.rateConfirmationId
        });
        loadId = approved.loadId;
      } catch (err) {
        approveError = err instanceof Error ? err.message : "approval failed";
      }
    }

    return NextResponse.json({
      rateConfirmationId: result.rateConfirmationId,
      parseState: rc?.parseState ?? null,
      parseConfidence: rc?.parseConfidence != null ? Number(rc.parseConfidence) : null,
      extractedPayload: rc?.extractedPayload ?? null,
      loadId,
      approveError
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", details: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal error" }, { status: 500 });
  }
}
