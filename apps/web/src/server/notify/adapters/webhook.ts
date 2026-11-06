import { createHmac } from "node:crypto";
import { webhookPayload, type Notice } from "@/lib/notify";
import { SEND_TIMEOUT_MS, failureOf, thrownOf, type Channel, type Env, type Fetch, type SendResult } from "../types";

/**
 * The generic outbound webhook: one signed JSON POST per notice, to an address only the server's environment names. This is the n8n path (a Webhook trigger receives it and routes it to Slack, Gmail,
 * Resend, SMS, anything), and works the same for any other receiver.
 *
 * Signing: `x-desk-signature: v1=<hex>`, an HMAC-SHA256 of `<timestamp>.<body>` with NOTIFY_WEBHOOK_SECRET, and the same timestamp in `x-desk-timestamp`, so a receiver can check who sent it and refuse
 * an old one. `x-desk-delivery` is the notice's dedupe key: a workflow can use it to drop a second delivery of the same thing (a send that died after the receiver got it is tried again). https only,
 * except http on this machine for the demo desk. No body, address or secret is ever put in an error or a log line.
 */
export const SIGNATURE_VERSION = "v1";

/** Whether an address may be posted to: https, or http to this machine when the desk is the demo (sign-in off). */
export function webhookUrlAllowed(raw: string | undefined, env: Env): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "http:" && local && env.DESK_AUTH !== "on";
}

export const sign = (secret: string, timestamp: string, body: string): string => `${SIGNATURE_VERSION}=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export const webhook: Channel = {
  name: "webhook",
  configured: (env) => webhookUrlAllowed(env.NOTIFY_WEBHOOK_URL, env) && Boolean(env.NOTIFY_WEBHOOK_SECRET?.trim()),
  async send(notice: Notice, env: Env, fetchFn: Fetch): Promise<SendResult> {
    const url = env.NOTIFY_WEBHOOK_URL?.trim();
    const secret = env.NOTIFY_WEBHOOK_SECRET?.trim();
    if (!url || !secret || !webhookUrlAllowed(url, env)) return { ok: false, error: "not configured", retry: false };
    const body = JSON.stringify(webhookPayload(notice));
    // Seconds since 1970, as the receiver counts them (a millisecond count with its last three digits cut).
    const timestamp = String(Date.now()).slice(0, -3);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-desk-event": notice.kind, "x-desk-delivery": notice.dedupeKey, "x-desk-timestamp": timestamp, "x-desk-signature": sign(secret, timestamp, body) },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
      return res.ok ? { ok: true } : failureOf(res.status);
    } catch (e) {
      return thrownOf(e);
    }
  }
};
