/**
 * Outbound webhook events and rules a screen may also read (docs/MONEY_PLAN.md, Wave 7 step 3). Pure and safe in a browser: the signing itself is src/lib/webhook-sign.ts.
 */
export const WEBHOOK_EVENTS = ["invoice.created", "invoice.voided", "credit_memo.created", "credit_memo.voided", "payment.applied", "payment.reversed", "statement.finalized", "statement.voided"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** The event a person sends from Settings to check a receiver. Never a money event. */
export const TEST_EVENT = "webhook.test";
export const isWebhookEvent = (v: unknown): v is WebhookEvent => typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);

export const EVENT_LABEL: Record<WebhookEvent, string> = {
  "invoice.created": "Invoice made",
  "invoice.voided": "Invoice taken back",
  "credit_memo.created": "Credit memo made",
  "credit_memo.voided": "Credit memo taken back",
  "payment.applied": "Payment recorded",
  "payment.reversed": "Payment taken back",
  "statement.finalized": "Driver statement finalized",
  "statement.voided": "Driver statement voided"
};


/**
 * Retries: after a failed attempt the next waits 5, 15, 60 minutes, then six hours each time (the same rhythm as a partner connection's health). The eighth failed attempt makes the
 * delivery dead; three dead deliveries in a row switch the endpoint off until an admin switches it on again.
 */
export const MAX_ATTEMPTS = 8;
export const DEAD_BEFORE_DISABLE = 3;
export const backoffMinutes = (failedAttempts: number): number => [5, 15, 60][failedAttempts - 1] ?? 360;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** How long a cron run holds a delivery it claimed: longer than one send can take, short enough that a run that died lets the next one have it. */
export const LEASE_MS = 120_000;

export function cleanEndpointInput(i: { url: unknown; label: unknown; events: unknown }): { ok: true; url: string; label: string | null; events: WebhookEvent[] } | { ok: false; error: string } {
  const url = typeof i.url === "string" ? i.url.trim() : "";
  const label = typeof i.label === "string" ? i.label.replace(/\s+/g, " ").trim().slice(0, 60) || null : null;
  const raw = Array.isArray(i.events) ? i.events : [];
  if (raw.some((e) => !isWebhookEvent(e))) return { ok: false, error: "That is not an event the desk sends." };
  const events = WEBHOOK_EVENTS.filter((e) => raw.includes(e));
  if (events.length === 0) return { ok: false, error: "Tick at least one event to send." };
  return { ok: true, url, label, events };
}
