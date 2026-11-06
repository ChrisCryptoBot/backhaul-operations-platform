import type { Notice } from "@/lib/notify";
import { SEND_TIMEOUT_MS, failureOf, thrownOf, type Channel, type Env, type Fetch, type SendResult } from "../types";

/**
 * Email through Resend, written and dark: on only when RESEND_API_KEY, NOTIFY_FROM_EMAIL and NOTIFY_TO_EMAIL are all set on the server. The addresses are the server's, never typed into the desk. The
 * notice's dedupe key goes as Resend's idempotency key, so a send that is tried twice makes one email.
 */
const ENDPOINT = "https://api.resend.com/emails";

const addresses = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a))
    .slice(0, 20);

export const resend: Channel = {
  name: "resend",
  configured: (env) => Boolean(env.RESEND_API_KEY?.trim()) && Boolean(env.NOTIFY_FROM_EMAIL?.trim()) && addresses(env.NOTIFY_TO_EMAIL).length > 0,
  async send(notice: Notice, env: Env, fetchFn: Fetch): Promise<SendResult> {
    const key = env.RESEND_API_KEY?.trim();
    const from = env.NOTIFY_FROM_EMAIL?.trim();
    const to = addresses(env.NOTIFY_TO_EMAIL);
    if (!key || !from || to.length === 0) return { ok: false, error: "not configured", retry: false };
    try {
      const res = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "idempotency-key": notice.dedupeKey.slice(0, 250) },
        body: JSON.stringify({ from, to, subject: notice.subject, text: notice.text, html: notice.html }),
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
      return res.ok ? { ok: true } : failureOf(res.status);
    } catch (e) {
      return thrownOf(e);
    }
  }
};
