import { describe, expect, test } from "vitest";
import { loadEnv } from "@/lib/env";

describe("env validation", () => {
  test("fails fast when required keys are missing", () => {
    expect(() => loadEnv({})).toThrowError(/Missing or invalid env vars/);
  });

  test("accepts complete contract", () => {
    const env = loadEnv({
      CLERK_SECRET_KEY: "sk",
      CLERK_PUBLISHABLE_KEY: "pk",
      DATABASE_URL: "https://example.com/db",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "bucket",
      SQS_PARSE_QUEUE_URL: "https://example.com/parse",
      SQS_RECOMPUTE_QUEUE_URL: "https://example.com/recompute",
      ANTHROPIC_API_KEY: "ak"
    });
    expect(env.AWS_REGION).toBe("us-east-1");
  });
});
