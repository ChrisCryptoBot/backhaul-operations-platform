import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

function localUploadDir(): string {
  return path.join(process.cwd(), ".uploads");
}

/**
 * Returns the S3 object key for a sourceFileUrl that points at the configured bucket
 * host, or null when the URL isn't an S3 bucket URL (e.g. local/dev). The bucket host
 * shape mirrors `sourceUrlFromName` in the rate-confirmations route.
 */
function s3KeyFromUrl(sourceFileUrl: string): { bucket: string; region: string; key: string } | null {
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(sourceFileUrl);
  } catch {
    return null;
  }
  const validHosts = new Set([`${bucket}.s3.${region}.amazonaws.com`, `${bucket}.s3.amazonaws.com`]);
  if (!validHosts.has(parsed.hostname)) {
    return null;
  }
  const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  return key ? { bucket, region, key } : null;
}

let cachedS3Client: S3Client | null = null;
function getS3Client(region: string): S3Client {
  if (!cachedS3Client) {
    cachedS3Client = new S3Client({ region });
  }
  return cachedS3Client;
}

async function readFromS3(target: { bucket: string; region: string; key: string }): Promise<Buffer> {
  const client = getS3Client(target.region);
  const result = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key }));
  if (!result.Body) {
    throw new Error(`S3 object ${target.key} returned no body.`);
  }
  const bytes = await result.Body.transformToByteArray();
  return Buffer.from(bytes);
}

function localUploadPath(hash: string): string {
  return path.join(localUploadDir(), `${hash}.pdf`);
}

function stagedUploadDir(): string {
  return path.join(localUploadDir(), "staged");
}

function stagedUploadPdfPath(uploadId: string): string {
  return path.join(stagedUploadDir(), `${uploadId}.pdf`);
}

function stagedUploadMetaPath(uploadId: string): string {
  return path.join(stagedUploadDir(), `${uploadId}.json`);
}

function isPresignedUrl(url: URL): boolean {
  return url.searchParams.has("X-Amz-Signature") || url.searchParams.has("X-Amz-Algorithm");
}

export async function persistUploadedPdf(input: {
  sourceFileUrl: string;
  sourceFileHash: string;
  fileBuffer: Buffer;
}): Promise<{ mode: "presigned-put" | "local-fallback"; localPath?: string }> {
  const parsed = new URL(input.sourceFileUrl);

  if (isPresignedUrl(parsed) && process.env.NODE_ENV !== "test") {
    const response = await fetch(input.sourceFileUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(input.fileBuffer)
    });
    if (!response.ok) {
      throw new Error(`Failed to upload file to presigned URL: ${response.status}`);
    }
    return { mode: "presigned-put" };
  }

  await mkdir(localUploadDir(), { recursive: true });
  const outputPath = localUploadPath(input.sourceFileHash);
  await writeFile(outputPath, input.fileBuffer);
  return { mode: "local-fallback", localPath: outputPath };
}

export async function readUploadedPdf(input: {
  sourceFileHash: string;
  /** The stored object URL; when it points at the configured S3 bucket, the PDF is
   * fetched via GetObject. Falls back to the local upload dir otherwise (dev/test). */
  sourceFileUrl?: string;
}): Promise<Buffer> {
  if (input.sourceFileUrl && process.env.NODE_ENV !== "test") {
    const target = s3KeyFromUrl(input.sourceFileUrl);
    if (target) {
      return readFromS3(target);
    }
  }
  return readFile(localUploadPath(input.sourceFileHash));
}

export async function createStagedUpload(input: {
  sourceFileName: string;
  sourceFileUrl: string;
}): Promise<{ uploadId: string; uploadUrl: string; sourceFileUrl: string; expiresAtIso: string }> {
  const uploadId = crypto.randomUUID();
  await mkdir(stagedUploadDir(), { recursive: true });
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const metadata = {
    sourceFileName: input.sourceFileName,
    sourceFileUrl: input.sourceFileUrl,
    createdAtIso: new Date().toISOString(),
    expiresAtIso: expiresAt.toISOString()
  };
  await writeFile(stagedUploadMetaPath(uploadId), JSON.stringify(metadata), "utf8");
  return {
    uploadId,
    uploadUrl: `/api/rate-confirmations?uploadId=${encodeURIComponent(uploadId)}`,
    sourceFileUrl: input.sourceFileUrl,
    expiresAtIso: expiresAt.toISOString()
  };
}

export async function writeStagedUploadBinary(input: { uploadId: string; fileBuffer: Buffer }): Promise<void> {
  await mkdir(stagedUploadDir(), { recursive: true });
  await writeFile(stagedUploadPdfPath(input.uploadId), input.fileBuffer);
}

export async function readStagedUpload(input: {
  uploadId: string;
}): Promise<{ fileBuffer: Buffer; sourceFileUrl: string; sourceFileName: string }> {
  const [fileBuffer, metadataBuffer] = await Promise.all([
    readFile(stagedUploadPdfPath(input.uploadId)),
    readFile(stagedUploadMetaPath(input.uploadId))
  ]);
  const parsed = JSON.parse(metadataBuffer.toString("utf8")) as {
    sourceFileName?: string;
    sourceFileUrl?: string;
    expiresAtIso?: string;
  };
  if (!parsed.sourceFileName || !parsed.sourceFileUrl || !parsed.expiresAtIso) {
    throw new Error("Staged upload metadata is incomplete.");
  }
  const expiresAt = new Date(parsed.expiresAtIso);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error("Staged upload expired. Please retry.");
  }
  return {
    fileBuffer,
    sourceFileName: parsed.sourceFileName,
    sourceFileUrl: parsed.sourceFileUrl
  };
}

export async function clearStagedUpload(input: { uploadId: string }): Promise<void> {
  await Promise.allSettled([
    rm(stagedUploadPdfPath(input.uploadId), { force: true }),
    rm(stagedUploadMetaPath(input.uploadId), { force: true })
  ]);
}

