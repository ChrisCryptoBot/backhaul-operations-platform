import { afterEach, beforeEach, describe, expect, test } from "vitest";
import crypto from "node:crypto";
import { decryptSecret, encryptSecret, lastFour } from "@/lib/crypto-config";

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;

describe("crypto-config secret encryption", () => {
  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
    }
  });

  test("round-trips a secret", () => {
    const secret = "sk-ant-test-1234567890";
    const cipher = encryptSecret(secret);
    expect(cipher).not.toContain(secret);
    expect(cipher.split(":")).toHaveLength(3);
    expect(decryptSecret(cipher)).toBe(secret);
  });

  test("produces a distinct ciphertext per call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("rejects a tampered ciphertext (GCM auth tag)", () => {
    const cipher = encryptSecret("secret");
    const [iv, tag, data] = cipher.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    const tampered = [iv, tag, flipped.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test("throws a clear error when the key is missing", () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrowError(/CONFIG_ENCRYPTION_KEY/);
  });

  test("throws when the key is not 32 bytes", () => {
    process.env.CONFIG_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x")).toThrowError(/32 bytes/);
  });

  test("lastFour returns the trailing 4 chars", () => {
    expect(lastFour("sk-ant-abcd1234")).toBe("1234");
  });
});
