import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_TTL_SECONDS, b64urlDecode, payloadOf, type SessionPayload } from "@/lib/session-cookie";

/**
 * Signing and checking the desk's session cookie: `base64url(payload).hex(HMAC-SHA256(body, secret))`. The secret is DESK_SESSION_SECRET; without one (or a short one) nothing is
 * signed and nothing verifies, so a desk with sign-in on and no secret refuses everyone instead of trusting an unsigned cookie.
 */
export const MIN_SECRET_LENGTH = 32;

const b64urlEncode = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");

export const usableSecret = (secret: string | undefined): secret is string => typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;

export function signSession(p: Omit<SessionPayload, "exp">, secret: string, nowMs = Date.now(), ttlSeconds = SESSION_TTL_SECONDS): string {
  if (!usableSecret(secret)) throw new Error(`DESK_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  const body = b64urlEncode(JSON.stringify({ ...p, exp: (nowMs - (nowMs % 1000)) / 1000 + ttlSeconds }));
  return `${body}.${mac(body, secret)}`;
}

/** The payload of a cookie that is signed with this secret, well formed and not expired; null for anything else. */
export function verifySession(token: string | undefined | null, secret: string | undefined, nowMs = Date.now()): SessionPayload | null {
  if (!token || !usableSecret(secret)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const want = Buffer.from(mac(body, secret), "hex");
  const got = Buffer.from(sig, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = payloadOf(JSON.parse(b64urlDecode(body)));
    return p && p.exp * 1000 > nowMs ? p : null;
  } catch {
    return null;
  }
}
