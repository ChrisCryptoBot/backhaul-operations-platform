import { isRole, type Role } from "./roles";

/**
 * The desk's own session cookie: who the signed-in person is on the desk (their member id, workspace, role and name), signed by the server so it cannot be edited, and tied to
 * the sign-in provider's user so it is useless without that sign-in. This file is the part that needs no secret and no Node, so the edge middleware can read it; the signing and
 * checking are in src/server/tl/session-token.ts. Pure.
 */
export const SESSION_COOKIE = "desk-session";
/** An hour. Every page and every change checks the member table again, so a removed person loses access at once; this only bounds how long a lookup is skipped. */
export const SESSION_TTL_SECONDS = 3600;

export type SessionPayload = {
  /** The sign-in provider's user id. The cookie is honoured only for the person who holds that sign-in. */
  uid: string;
  /** The workspace the person works in. */
  ws: string;
  role: Role;
  name: string;
  email: string | null;
  /** Expiry, in seconds since 1970. */
  exp: number;
};

/** base64url, with no padding, of text, in any runtime (the edge has atob and no Buffer). */
export function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = typeof atob === "function" ? atob(pad) : Buffer.from(pad, "base64").toString("binary");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function payloadOf(raw: unknown): SessionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.uid !== "string" || !p.uid || typeof p.ws !== "string" || !p.ws || !isRole(p.role) || typeof p.name !== "string" || typeof p.exp !== "number") return null;
  return { uid: p.uid, ws: p.ws, role: p.role, name: p.name, email: typeof p.email === "string" ? p.email : null, exp: p.exp };
}

/**
 * What a cookie says, WITHOUT checking its signature: only for deciding whether to send someone to be signed in to the desk (the middleware). Anything that trusts the
 * answer uses `verifySession` on the server instead.
 */
export function peekSession(token: string | undefined | null, nowMs: number): SessionPayload | null {
  if (!token) return null;
  const [body] = token.split(".");
  if (!body) return null;
  try {
    const p = payloadOf(JSON.parse(b64urlDecode(body)));
    return p && p.exp * 1000 > nowMs ? p : null;
  } catch {
    return null;
  }
}
