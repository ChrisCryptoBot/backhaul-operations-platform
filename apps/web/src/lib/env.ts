import { z } from "zod";

export const envSchema = z
  .object({
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
    DATABASE_URL: z.string().url(),
    // AWS S3/SQS infra. Required in production (fail fast on a misconfigured
    // deploy), but optional in dev/test so the app can boot and run the
    // ingestion pipeline locally without AWS (PDFs fall back to ./.uploads/ and
    // queue jobs no-op — see orchestrator-adapter + upload-storage).
    AWS_REGION: z.string().min(1).optional(),
    S3_BUCKET_NAME: z.string().min(1).optional(),
    SQS_PARSE_QUEUE_URL: z.string().url().optional(),
    SQS_RECOMPUTE_QUEUE_URL: z.string().url().optional(),
    // Seed/fallback LLM credentials. The active key normally lives in the
    // LlmProviderConfig table (managed via Settings); these env vars are an
    // optional bootstrap fallback, so they are no longer required at boot.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    LLM_PROVIDER: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).optional(),
    // Bootstrap secret used to AES-256-GCM encrypt at-rest secrets (e.g. the LLM
    // API key) before persistence. Validated at use time by crypto-config.
    CONFIG_ENCRYPTION_KEY: z.string().min(1).optional(),
    PHASE1_REGION_CODE: z.string().regex(/^[A-Z]{2,4}$/).default("NE")
  })
  .superRefine((env, ctx) => {
    // In production the AWS infra must be fully configured.
    if (process.env.NODE_ENV !== "production") return;
    for (const key of ["AWS_REGION", "S3_BUCKET_NAME", "SQS_PARSE_QUEUE_URL", "SQS_RECOMPUTE_QUEUE_URL"] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required in production.` });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;
const phase1RegionCodeSchema = z.string().regex(/^[A-Z]{2,4}$/);

/** True when S3 + SQS are configured — i.e. the real AWS ingestion path is available. */
export function isAwsConfigured(input: Record<string, string | undefined> = process.env): boolean {
  return Boolean(input.AWS_REGION && input.S3_BUCKET_NAME && input.SQS_PARSE_QUEUE_URL && input.SQS_RECOMPUTE_QUEUE_URL);
}

export function loadEnv(input: Record<string, string | undefined> = process.env): AppEnv {
  // Clerk's publishable key is the same value under both names; accept the
  // NEXT_PUBLIC_ variant as the source of truth when the bare name is unset.
  const normalized = {
    ...input,
    CLERK_PUBLISHABLE_KEY: input.CLERK_PUBLISHABLE_KEY ?? input.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  };
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid env vars: ${errors}`);
  }
  return parsed.data;
}

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }
  return cachedEnv;
}

export function getPhase1RegionCode(input: Record<string, string | undefined> = process.env): string {
  const raw = input.PHASE1_REGION_CODE ?? "NE";
  return phase1RegionCodeSchema.parse(raw);
}
