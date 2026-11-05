import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { triumphEventToNeutral } from "./adapters/triumphpay";

/**
 * A company's webhook, the pure part (docs/PARTNER_BACKBONE.md). No company's real signing scheme or payload is in this repo, and none is guessed: the receiver verifies a hex HMAC-SHA256 of the
 * raw body (the scheme the partner contract assumes) under a header that is one line to change per company, and reads events in a neutral envelope that each company's adapter maps its own
 * payload into when that company is chosen. A wrong assumption fails closed: every real event would be refused as an invalid signature, never accepted unverified.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** The header each company signs with. Every company is the same until one is chosen and its real header is set here. */
export const SIGNATURE_HEADER: Record<string, string> = {};
export const signatureHeaderFor = (provider: string): string => SIGNATURE_HEADER[provider] ?? "x-signature";

/** The signature as sent, "<hex>" or "sha256=<hex>", compared in constant time against the HMAC of the raw bytes. Anything malformed is simply not valid. */
export function verifySignature(raw: string, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const want = createHmac("sha256", secret).update(raw, "utf8").digest();
  return timingSafeEqual(Buffer.from(given, "hex"), want);
}

/** The neutral envelope an adapter maps a company's event into. */
export type PartnerEventKind = "factoring.submitted" | "factoring.funded" | "factoring.paid" | "factoring.rejected" | "ping";
export const EVENT_KINDS: readonly PartnerEventKind[] = ["factoring.submitted", "factoring.funded", "factoring.paid", "factoring.rejected", "ping"];

export type NeutralEvent = {
  /** The company's own id for this event: what makes a repeat recognisable. */
  id: string;
  kind: PartnerEventKind;
  /** For a factoring event: the invoice number or the factor's reference the desk can find a load by. */
  reference: string | null;
  /** The factor's own reference for the invoice, kept when it is new. */
  referenceId: string | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/**
 * Read the neutral envelope: `{ id?, type, reference?, reference_id? }`. A body that is not that shape is null (recorded as ignored). A body with no event id gets a stable one from its own
 * bytes, so the same delivery twice is still one event.
 */
export function readNeutralEvent(parsed: unknown, raw: string): NeutralEvent | null {
  if (!isObj(parsed)) return null;
  const type = text(parsed.type, 40);
  if (!type || !(EVENT_KINDS as readonly string[]).includes(type)) return null;
  const id = text(parsed.id, 120) ?? text(parsed.event_id, 120) ?? `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
  return { id, kind: type as PartnerEventKind, reference: text(parsed.reference, 80), referenceId: text(parsed.reference_id, 80) };
}

/**
 * An event as the receiver reads it: the company's own shape when it has an adapter that knows it (TriumphPay's, modeled in adapters/triumphpay.ts), else the neutral envelope. A body that is
 * neither is null, recorded as ignored.
 */
const OWN_SHAPE: Record<string, (parsed: unknown) => NeutralEvent | null> = { triumphpay: triumphEventToNeutral };
export function readEvent(provider: string, parsed: unknown, raw: string): NeutralEvent | null {
  return OWN_SHAPE[provider]?.(parsed) ?? readNeutralEvent(parsed, raw);
}

/** The factoring status an event moves a load to, or null for an event that is not a factoring move. */
export const factoringStatusOf = (kind: PartnerEventKind): string | null => (kind === "factoring.submitted" ? "submitted" : kind === "factoring.funded" ? "funded" : kind === "factoring.paid" ? "paid" : kind === "factoring.rejected" ? "rejected" : null);
