import { createHmac, timingSafeEqual } from "node:crypto";
export * from "./webhook-events";

/**
 * Outbound webhooks (docs/MONEY_PLAN.md, Wave 7 step 3): the signature. Pure, server only (node:crypto); the events and the retry rules are in ./webhook-events.ts, which a screen may import.
 *
 * Each delivery carries three headers:
 *   x-truelane-event-id   the event's id (evt_...), the same on every retry and on every endpoint it goes to: the receiver keeps it to do each event once;
 *   x-truelane-timestamp  seconds since 1970 when this attempt was signed;
 *   x-truelane-signature  t=<that timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" under the endpoint's signing secret>.
 * A receiver recomputes v1 over the raw bytes it received, compares in constant time, and refuses a timestamp more than five minutes from its own clock. A retry signs again with a new
 * timestamp; the body (and so the event) is the same.
 */
export const HEADER_EVENT_ID = "x-truelane-event-id";
export const HEADER_TIMESTAMP = "x-truelane-timestamp";
export const HEADER_SIGNATURE = "x-truelane-signature";
export const TOLERANCE_SECONDS = 300;

export const signatureOf = (secret: string, timestamp: number, rawBody: string): string => createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
export const signatureHeader = (secret: string, timestamp: number, rawBody: string): string => `t=${timestamp},v1=${signatureOf(secret, timestamp, rawBody)}`;

/** What a receiver does: the header's timestamp within tolerance of its clock, and v1 equal to its own HMAC, compared in constant time. */
export function verifySignatureHeader(header: string | null, secret: string, rawBody: string, nowSeconds: number, tolerance = TOLERANCE_SECONDS): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = /^\d{1,12}$/.test(parts.t ?? "") ? Number.parseInt(parts.t!, 10) : NaN;
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > tolerance) return false;
  const given = /^[0-9a-f]{64}$/.test(parts.v1 ?? "") ? Buffer.from(parts.v1!, "hex") : null;
  if (!given) return false;
  return timingSafeEqual(given, Buffer.from(signatureOf(secret, t, rawBody), "hex"));
}

/** An endpoint's signing secret: whsec_ and 32 random bytes in base64url. Made on the server (crypto), shown once. */
export const SECRET_PREFIX = "whsec_";
