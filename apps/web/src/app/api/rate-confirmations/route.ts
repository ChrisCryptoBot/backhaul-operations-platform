import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { computeContentHash, finalizeUpload } from "@/server/ingestion";
import { getEnv } from "@/lib/env";
import { weekIsoFromPickup } from "@/lib/week";
import { runInRegionScope } from "@/lib/db";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { IdempotencyConflictError } from "@/lib/idempotency-error";
import { isWriteBypassed } from "@/lib/auth-mode";
import {
  uploadConfirmRequestSchema,
  uploadFinalizeContractVersion,
  uploadFinalizeResponseSchema,
  uploadLegacyFinalizeRequestSchema,
  uploadPrepareRequestSchema,
  uploadPrepareResponseSchema
} from "@/contracts/upload-finalize";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import {
  clearStagedUpload,
  createStagedUpload,
  persistUploadedPdf,
  readStagedUpload,
  writeStagedUploadBinary
} from "@/server/upload-storage";

function sourceUrlFromName(fileName: string, bucketName: string, awsRegion: string): string {
  const sanitized = fileName.trim().replace(/\s+/g, "_");
  const objectKey = `uploads/${Date.now()}-${sanitized}`;
  return `https://${bucketName}.s3.${awsRegion}.amazonaws.com/${encodeURIComponent(objectKey)}`;
}

function looksLikePdf(buffer: Buffer): boolean {
  if (buffer.length < 5) {
    return false;
  }
  return buffer.subarray(0, 5).toString("utf8") === "%PDF-";
}

function isPdfFileName(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  return value.trim().toLowerCase().endsWith(".pdf");
}

function assertBucketHostUrl(sourceFileUrl: string, bucketName: string, awsRegion: string): URL {
  const sourceUrl = new URL(sourceFileUrl);
  const validHosts = new Set([`${bucketName}.s3.${awsRegion}.amazonaws.com`, `${bucketName}.s3.amazonaws.com`]);
  if (!validHosts.has(sourceUrl.hostname)) {
    throw new Error("sourceFileUrl must point to configured S3 bucket host");
  }
  return sourceUrl;
}

async function requireUploadAccess(actorUserId: string, regionId: string, bypassWrites: boolean): Promise<void> {
  if (bypassWrites) {
    return;
  }
  const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
  policyAdapter.assertPermission(access, { resource: "RATE_CONFIRMATION_UPLOAD", action: "WRITE" });
}

async function finalizePersistedUpload(input: {
  actorUserId: string;
  idempotencyKey?: string;
  regionId: string;
  pickupDate: Date;
  sourceFileUrl: string;
  fileBuffer: Buffer;
  intakeDriverType?: "SHUTTLE" | "PTP" | "LTL";
}): Promise<NextResponse> {
  const contentHash = computeContentHash(input.fileBuffer);
  const weekIso = weekIsoFromPickup(input.pickupDate);
  await persistUploadedPdf({
    sourceFileUrl: input.sourceFileUrl,
    sourceFileHash: contentHash,
    fileBuffer: input.fileBuffer
  });

  const result = await runInRegionScope(input.regionId, async (tx) =>
    finalizeUpload({
      regionId: input.regionId,
      weekIso,
      sourceFileUrl: input.sourceFileUrl,
      sourceFileHash: contentHash,
      acceptedById: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      intakeDriverType: input.intakeDriverType,
      db: tx,
      enqueueParseJob: true
    })
  );
  const response = uploadFinalizeResponseSchema.parse({
    contractVersion: uploadFinalizeContractVersion,
    rateConfirmationId: result.rateConfirmationId,
    duplicateKind: result.duplicateKind,
    alreadyExisted: result.alreadyExisted
  });
  return NextResponse.json(response, { status: result.alreadyExisted ? 200 : 201 });
}

async function resolveActor(): Promise<{ actorUserId: string; bypassWrites: boolean } | NextResponse> {
  const { userId } = await auth();
  const bypassWrites = isWriteBypassed();
  if (!bypassWrites && !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { actorUserId: userId ?? "dev-bypass-user", bypassWrites };
}

export async function PUT(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const uploadId = searchParams.get("uploadId");
    if (!uploadId) {
      return NextResponse.json({ error: "Missing uploadId" }, { status: 400 });
    }
    const buffer = Buffer.from(await request.arrayBuffer());
    if (!looksLikePdf(buffer)) {
      return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
    }
    await writeStagedUploadBinary({ uploadId, fileBuffer: buffer });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actorContext = await resolveActor();
    if (actorContext instanceof NextResponse) {
      return actorContext;
    }
    const { actorUserId, bypassWrites } = actorContext;
    const { S3_BUCKET_NAME, AWS_REGION } = getEnv();
    if (!S3_BUCKET_NAME || !AWS_REGION) {
      // HTTP uploads need S3 for the presigned object URL. For local/dev without
      // AWS, use scripts/ingest-local.mjs (filesystem + inline parse) instead.
      return NextResponse.json(
        { error: "Uploads require S3 configuration. Use scripts/ingest-local.mjs for local testing." },
        { status: 503 }
      );
    }
    const body = await request.json();
    const operation = typeof body.operation === "string" ? body.operation : null;

    if (operation === "prepare-upload") {
      const payload = uploadPrepareRequestSchema.parse({
        contractVersion: body.contractVersion ?? uploadFinalizeContractVersion,
        operation: body.operation,
        regionId: body.regionId,
        pickupDate: body.pickupDate,
        sourceFileName: body.sourceFileName,
        intakeDriverType: body.intakeDriverType
      });
      await requireUploadAccess(actorUserId, payload.regionId, bypassWrites);
      const sourceFileUrl = sourceUrlFromName(payload.sourceFileName, S3_BUCKET_NAME, AWS_REGION);
      assertBucketHostUrl(sourceFileUrl, S3_BUCKET_NAME, AWS_REGION);
      const staged = await createStagedUpload({
        sourceFileName: payload.sourceFileName,
        sourceFileUrl
      });
      const response = uploadPrepareResponseSchema.parse({
        contractVersion: uploadFinalizeContractVersion,
        operation: "prepare-upload",
        uploadId: staged.uploadId,
        uploadUrl: staged.uploadUrl,
        sourceFileUrl: staged.sourceFileUrl,
        expiresAtIso: staged.expiresAtIso
      });
      return NextResponse.json(response, { status: 201 });
    }

    if (operation === "finalize-upload") {
      const payload = uploadConfirmRequestSchema.parse({
        contractVersion: body.contractVersion ?? uploadFinalizeContractVersion,
        operation: body.operation,
        regionId: body.regionId,
        pickupDate: body.pickupDate,
        uploadId: body.uploadId
      });
      await requireUploadAccess(actorUserId, payload.regionId, bypassWrites);
      const staged = await readStagedUpload({ uploadId: payload.uploadId });
      const sourceUrl = assertBucketHostUrl(staged.sourceFileUrl, S3_BUCKET_NAME, AWS_REGION);
      const pathName = decodeURIComponent(sourceUrl.pathname.split("/").pop() ?? "");
      if (!isPdfFileName(staged.sourceFileName) || !isPdfFileName(pathName) || !looksLikePdf(staged.fileBuffer)) {
        return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
      }
      const response = await finalizePersistedUpload({
        actorUserId,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
        regionId: payload.regionId,
        pickupDate: payload.pickupDate,
        sourceFileUrl: staged.sourceFileUrl,
        fileBuffer: staged.fileBuffer,
        intakeDriverType: payload.intakeDriverType
      });
      await clearStagedUpload({ uploadId: payload.uploadId });
      return response;
    }

    const payload = uploadLegacyFinalizeRequestSchema.parse({
      contractVersion: body.contractVersion ?? uploadFinalizeContractVersion,
      regionId: body.regionId,
      pickupDate: body.pickupDate,
      sourceFileUrl: body.sourceFileUrl,
      sourceFileName: body.sourceFileName,
      fileContentBase64: body.fileContentBase64,
      intakeDriverType: body.intakeDriverType
    });
    const sourceFileUrl = payload.sourceFileUrl ?? sourceUrlFromName(payload.sourceFileName!, S3_BUCKET_NAME, AWS_REGION);
    const sourceUrl = assertBucketHostUrl(sourceFileUrl, S3_BUCKET_NAME, AWS_REGION);
    const pathName = decodeURIComponent(sourceUrl.pathname.split("/").pop() ?? "");
    if (!isPdfFileName(payload.sourceFileName) || !isPdfFileName(pathName)) {
      return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
    }
    const fileBuffer = Buffer.from(payload.fileContentBase64, "base64");
    if (!looksLikePdf(fileBuffer)) {
      return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
    }
    await requireUploadAccess(actorUserId, payload.regionId, bypassWrites);
    return await finalizePersistedUpload({
      actorUserId,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
      regionId: payload.regionId,
      pickupDate: payload.pickupDate,
      sourceFileUrl,
      fileBuffer,
      intakeDriverType: payload.intakeDriverType
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("sourceFileUrl")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message.includes("Staged upload")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
