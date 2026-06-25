import { z } from "zod";

export const uploadFinalizeContractVersion = "v1";

export const uploadPrepareRequestSchema = z.object({
  contractVersion: z.literal(uploadFinalizeContractVersion),
  operation: z.literal("prepare-upload"),
  regionId: z.string().min(1),
  pickupDate: z.coerce.date(),
  sourceFileName: z.string().min(1),
  intakeDriverType: z.enum(["SHUTTLE", "PTP", "LTL"]).optional()
});

export const uploadPrepareResponseSchema = z.object({
  contractVersion: z.literal(uploadFinalizeContractVersion),
  operation: z.literal("prepare-upload"),
  uploadId: z.string().min(1),
  uploadUrl: z.string().min(1),
  sourceFileUrl: z.string().url(),
  expiresAtIso: z.string().datetime()
});

export const uploadConfirmRequestSchema = z.object({
  contractVersion: z.literal(uploadFinalizeContractVersion),
  operation: z.literal("finalize-upload"),
  regionId: z.string().min(1),
  pickupDate: z.coerce.date(),
  uploadId: z.string().min(1),
  intakeDriverType: z.enum(["SHUTTLE", "PTP", "LTL"]).optional()
});

export const uploadLegacyFinalizeRequestSchema = z
  .object({
    contractVersion: z.literal(uploadFinalizeContractVersion),
    regionId: z.string().min(1),
    pickupDate: z.coerce.date(),
    sourceFileUrl: z.string().url().optional(),
    sourceFileName: z.string().min(1).optional(),
    fileContentBase64: z.string().min(1),
    intakeDriverType: z.enum(["SHUTTLE", "PTP", "LTL"]).optional()
  })
  .refine((value) => Boolean(value.sourceFileUrl || value.sourceFileName), {
    message: "Provide sourceFileUrl or sourceFileName"
  });

export const uploadFinalizeRequestSchema = z.union([
  uploadPrepareRequestSchema,
  uploadConfirmRequestSchema,
  uploadLegacyFinalizeRequestSchema
]);

export type UploadFinalizeRequest = z.infer<typeof uploadFinalizeRequestSchema>;

export const uploadFinalizeResponseSchema = z.object({
  contractVersion: z.literal(uploadFinalizeContractVersion),
  rateConfirmationId: z.string().min(1),
  duplicateKind: z.enum(["NONE", "EXACT_DUPLICATE", "SOFT_DUPLICATE_WARNING"]).default("NONE"),
  alreadyExisted: z.boolean().default(false)
});

export type UploadFinalizeResponse = z.infer<typeof uploadFinalizeResponseSchema>;

