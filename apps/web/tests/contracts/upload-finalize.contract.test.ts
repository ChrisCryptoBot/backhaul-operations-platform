import { describe, expect, test } from "vitest";
import { uploadFinalizeRequestSchema, uploadFinalizeContractVersion } from "@/contracts/upload-finalize";

describe("upload finalize contract", () => {
  test("validates v1 request", () => {
    const parsed = uploadFinalizeRequestSchema.parse({
      contractVersion: uploadFinalizeContractVersion,
      regionId: "r1",
      pickupDate: "2026-05-01",
      sourceFileName: "ratecon.pdf",
      fileContentBase64: Buffer.from("%PDF-1.4").toString("base64")
    });
    expect(parsed.contractVersion).toBe("v1");
  });
});

