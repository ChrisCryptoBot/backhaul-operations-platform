import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A fleet's own keys for a partner company, sealed for storage. The pure part: no database, no environment but what is passed in, so it can be tested without either.
 *
 * AES-256-GCM with a fresh 12-byte nonce for every seal; the server key (`DESK_CREDENTIAL_KEY`, 32 random bytes in base64) lives in the host's environment, never in the database, so a copy
 * of the database alone opens nothing. The envelope is "v1.<nonce>.<tag>.<ciphertext>", each part base64url, and the version leaves room to rotate the key. A wrong key, a changed byte
 * or a malformed envelope opens to null: GCM refuses a message that was altered, so a tampered row is "no credential", never a wrong one.
 */
export const CREDENTIAL_KEY_ENV = "DESK_CREDENTIAL_KEY";

/** The key from the environment: 32 bytes of base64 (or base64url), else null. A short or malformed key is no key: sealing with it would be a false comfort. */
export function credentialKey(env: Record<string, string | undefined>): Buffer | null {
  const raw = env[CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? key : null;
}

const b64 = (b: Buffer) => b.toString("base64url");

export function seal(values: Record<string, string>, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  return `v1.${b64(nonce)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function unseal(sealed: string, key: Buffer): Record<string, string> | null {
  try {
    const [v, nonce, tag, body] = sealed.split(".");
    if (v !== "v1" || !nonce || !tag || !body) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    const out = JSON.parse(text) as unknown;
    if (!out || typeof out !== "object" || Array.isArray(out)) return null;
    const clean: Record<string, string> = {};
    for (const [k, val] of Object.entries(out as Record<string, unknown>)) if (typeof val === "string") clean[k] = val;
    return clean;
  } catch {
    return null;
  }
}

/** What a screen may show of a secret: its last four characters, "…abcd", or a bare "set" when it is too short for any of it to be safe to show. */
export function hintOf(value: string): string {
  return value.length >= 12 ? `…${value.slice(-4)}` : "set";
}

export type CredentialCheck = { ok: true; values: Record<string, string> } | { ok: false; error: string };

/**
 * What a form sent, checked against the secret names the company needs: only those names, each a single line of printable characters between 8 and 400 long, and at least one of them.
 * A blank field is "keep what is there", so changing one of two keys does not need the other typed again.
 */
export function checkCredential(raw: Record<string, unknown>, allowed: readonly string[]): CredentialCheck {
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!allowed.includes(name)) return { ok: false, error: "That is not a key this company uses." };
    const s = typeof v === "string" ? v.trim() : "";
    if (s === "") continue;
    if (s.length < 8 || s.length > 400 || /[\r\n\u0000-\u001f]/.test(s)) return { ok: false, error: `${name} does not look like a key: 8 to 400 characters on one line.` };
    values[name] = s;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: "Paste a key to save." };
  return { ok: true, values };
}

/** An unguessable webhook address part: 24 random bytes. */
export const newWebhookToken = (): string => randomBytes(24).toString("base64url");
