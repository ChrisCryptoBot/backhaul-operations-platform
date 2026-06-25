import { beforeEach, describe, expect, test, vi } from "vitest";
import { PolicyViolationError } from "@/lib/policy-error";
import { IdempotencyConflictError } from "@/lib/idempotency-error";

const auth = vi.fn();
const requireRegionAccess = vi.fn();
const assertPermission = vi.fn();
const runInRegionScope = vi.fn();
const finalizeUpload = vi.fn();
const persistUploadedPdf = vi.fn();
const writeStagedUploadBinary = vi.fn();
const createStagedUpload = vi.fn();
const readStagedUpload = vi.fn();
const clearStagedUpload = vi.fn();
const isWriteBypassed = vi.fn();
const pdfFixtureBase64 = "JVBERi0xLjQgZmFrZQ==";

vi.mock("@clerk/nextjs/server", () => ({
  auth
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    S3_BUCKET_NAME: "backhaul-ratecons",
    AWS_REGION: "us-east-1"
  })
}));

vi.mock("@/domain/policy/policy-adapter", () => ({
  policyAdapter: {
    requireRegionAccess,
    assertPermission
  }
}));

vi.mock("@/lib/db", () => ({
  runInRegionScope
}));

vi.mock("@/server/ingestion", () => ({
  computeContentHash: () => "hash-1",
  finalizeUpload
}));

vi.mock("@/server/upload-storage", () => ({
  persistUploadedPdf,
  writeStagedUploadBinary,
  createStagedUpload,
  readStagedUpload,
  clearStagedUpload
}));

vi.mock("@/lib/auth-mode", () => ({
  isWriteBypassed
}));

describe("POST /api/rate-confirmations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWriteBypassed.mockReturnValue(false);
    persistUploadedPdf.mockResolvedValue({ mode: "local-fallback" });
    createStagedUpload.mockResolvedValue({
      uploadId: "upload-1",
      uploadUrl: "/api/rate-confirmations?uploadId=upload-1",
      sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/uploads/upload-1.pdf",
      expiresAtIso: "2026-05-04T09:00:00.000Z"
    });
    readStagedUpload.mockResolvedValue({
      sourceFileName: "ratecon.pdf",
      sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/uploads/upload-1.pdf",
      fileBuffer: Buffer.from("%PDF-1.4 fake")
    });
    runInRegionScope.mockImplementation(async (_regionId: string, fn: () => Promise<unknown>) => fn());
  });

  test("rejects malformed payloads", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        body: JSON.stringify({ pickupDate: "bad" })
      })
    );
    expect(response.status).toBe(400);
  }, 10000);

  test("returns 401 for unauthenticated requests", async () => {
    auth.mockResolvedValue({ userId: null });
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );
    expect(response.status).toBe(401);
  });

  test("requires region membership", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new PolicyViolationError("Forbidden"));
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden" });
  });

  test("returns 500 when region access lookup fails unexpectedly", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockRejectedValue(new Error("database timeout"));
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "Internal server error" });
  });

  test("succeeds for valid canonical payload", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    finalizeUpload.mockResolvedValue({ rateConfirmationId: "rc-1", duplicateKind: "NONE", alreadyExisted: false });

    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-1"
        },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contractVersion: "v1",
      rateConfirmationId: "rc-1",
      duplicateKind: "NONE",
      alreadyExisted: false
    });
    expect(persistUploadedPdf).toHaveBeenCalledTimes(1);
    expect(finalizeUpload).toHaveBeenCalledTimes(1);
    expect(finalizeUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueueParseJob: true
      })
    );
  });

  test("accepts sourceFileName when sourceFileUrl is omitted", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    finalizeUpload.mockResolvedValue({ rateConfirmationId: "rc-1", duplicateKind: "NONE", alreadyExisted: false });

    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileName: "ratecon.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );

    expect(response.status).toBe(201);
    expect(finalizeUpload).toHaveBeenCalledTimes(1);
  });

  test("returns 409 on idempotency hash conflict", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    finalizeUpload.mockRejectedValue(new IdempotencyConflictError("Idempotency-Key conflict: payload hash differs from existing request"));
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-1"
        },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Idempotency-Key conflict: payload hash differs from existing request"
    });
  });

  test("allows unauthenticated write only when explicit write bypass is enabled", async () => {
    isWriteBypassed.mockReturnValue(true);
    auth.mockResolvedValue({ userId: null });
    finalizeUpload.mockResolvedValue({ rateConfirmationId: "rc-1", duplicateKind: "NONE", alreadyExisted: false });
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/file.pdf",
          fileContentBase64: pdfFixtureBase64
        })
      })
    );
    expect(response.status).toBe(201);
  });

  test("rejects non-PDF payloads at API boundary", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    const { POST } = await import("@/app/api/rate-confirmations/route");
    const response = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileName: "note.txt",
          fileContentBase64: "ZmFrZQ=="
        })
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Only PDF files are accepted." });
  });

  test("supports two-step direct upload handshake", async () => {
    auth.mockResolvedValue({ userId: "user-1" });
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    finalizeUpload.mockResolvedValue({ rateConfirmationId: "rc-step-1", duplicateKind: "NONE", alreadyExisted: false });
    const { POST, PUT } = await import("@/app/api/rate-confirmations/route");

    const prepareResponse = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: "v1",
          operation: "prepare-upload",
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          sourceFileName: "ratecon.pdf"
        })
      })
    );
    expect(prepareResponse.status).toBe(201);

    const uploadResponse = await PUT(
      new Request("http://localhost/api/rate-confirmations?uploadId=upload-1", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: "%PDF-1.4 direct"
      })
    );
    expect(uploadResponse.status).toBe(204);
    expect(writeStagedUploadBinary).toHaveBeenCalledTimes(1);

    const finalizeResponse = await POST(
      new Request("http://localhost/api/rate-confirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractVersion: "v1",
          operation: "finalize-upload",
          regionId: "region-1",
          pickupDate: "2026-04-27T12:00:00.000Z",
          uploadId: "upload-1"
        })
      })
    );
    expect(finalizeResponse.status).toBe(201);
    expect(clearStagedUpload).toHaveBeenCalledWith({ uploadId: "upload-1" });
  });
});
