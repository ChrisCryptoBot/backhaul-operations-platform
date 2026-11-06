import type { Notice } from "@/lib/notify";
import { SEND_TIMEOUT_MS, failureOf, thrownOf, type Channel, type Env, type Fetch, type SendResult } from "../types";

/**
 * A Slack incoming webhook, written and dark: on only when SLACK_WEBHOOK_URL is set on the server, and only to Slack's own host. (Through n8n, Slack is reached by the generic webhook instead; this is
 * for a desk that wants Slack without n8n.)
 */
const HOST = "hooks.slack.com";

export const slackUrlAllowed = (raw: string | undefined): boolean => {
  try {
    const u = new URL((raw ?? "").trim());
    return u.protocol === "https:" && u.hostname === HOST && !u.username && !u.password;
  } catch {
    return false;
  }
};

export const slack: Channel = {
  name: "slack",
  configured: (env) => slackUrlAllowed(env.SLACK_WEBHOOK_URL),
  async send(notice: Notice, env: Env, fetchFn: Fetch): Promise<SendResult> {
    const url = env.SLACK_WEBHOOK_URL?.trim();
    if (!url || !slackUrlAllowed(url)) return { ok: false, error: "not configured", retry: false };
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${notice.subject}*\n${notice.text}` }),
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
      return res.ok ? { ok: true } : failureOf(res.status);
    } catch (e) {
      return thrownOf(e);
    }
  }
};
