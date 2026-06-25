import crypto from "node:crypto";

/**
 * Symmetric encryption for at-rest secrets (e.g. the LLM provider API key).
 *
 * Uses AES-256-GCM with a 32-byte key supplied via the CONFIG_ENCRYPTION_KEY
 * environment variable (base64-encoded). The serialized format is three
 * base64 parts joined by ":" — `iv:authTag:ciphertext`.
 *
 * The raw secret is never persisted; callers store only the output of
 * {@link encryptSecret} plus a short masked suffix for display.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // standard GCM nonce length

function getKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CONFIG_ENCRYPTION_KEY is not set; cannot encrypt or decrypt secrets.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CONFIG_ENCRYPTION_KEY must decode to 32 bytes (base64-encoded 256-bit key).");
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(serialized: string): string {
  const key = getKey();
  const parts = serialized.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret.");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/** Last 4 characters of a secret, for non-sensitive masked display. */
export function lastFour(secret: string): string {
  return secret.slice(-4);
}
