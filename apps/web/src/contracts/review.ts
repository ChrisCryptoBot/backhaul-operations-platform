import { z } from "zod";

export const reviewContractVersion = "v1";

export const reviewRateConfirmationSchema = z.object({
  contractVersion: z.literal(reviewContractVersion).optional(),
  id: z.string().min(1),
  parseState: z.string().min(1),
  reviewDecision: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  sourceFileUrl: z.string().url(),
  extractedPayload: z.record(z.string(), z.unknown()).nullable(),
  loadId: z.string().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedById: z.string().nullable(),
  reviewReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type ReviewRateConfirmationContract = z.infer<typeof reviewRateConfirmationSchema>;

