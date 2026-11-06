import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { signalNotice, type SignalFacts } from "@/lib/notify";
import { CHANNELS, configuredChannels } from "@/server/notify";
import { resend } from "@/server/notify/adapters/resend";
import { slack, slackUrlAllowed } from "@/server/notify/adapters/slack";
import { sign, webhook, webhookUrlAllowed } from "@/server/notify/adapters/webhook";
import type { Fetch } from "@/server/notify/types";

/**
 * The channels with a fake `fetch`: no test here touches the network. What is checked is what leaves (the address, the signature, the body), when a channel is on at all, and that no answer or error ever
 * carries a body, a key or an address.
 */
const notice = signalNotice({ id: "s1", key: "l1:NO_TRUCK", code: "NO_TRUCK", level: "block", title: "No truck", detail: "DM-1 has no truck.", loadId: "l1", loadNumber: "DM-1", unit: "101", dollars: 1250, firstSeenAt: 0, reopenCount: 0, deskUrl: "https://desk.example.com" } satisfies SignalFacts);

const ENV = { NOTIFY_WEBHOOK_URL: "https://n8n.example.com/webhook/abc123-secret-path", NOTIFY_WEBHOOK_SECRET: "whsec_top_secret_value" };
type Call = { url: string; init: RequestInit };
const fake = (answer: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as unknown as Fetch;
  return { f, calls };
};
const headerOf = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe("which channels are on", () => {
  test("none on a real desk with nothing set; the simulator only on the demo desk or when the operator switched it on", () => {
    expect(configuredChannels({ DESK_AUTH: "on" })).toEqual([]);
    expect(configuredChannels({}).map((c) => c.name)).toEqual(["sandbox"]);
    expect(configuredChannels({ DESK_AUTH: "on", DESK_PARTNER_SANDBOX: "on" }).map((c) => c.name)).toEqual(["sandbox"]);
    expect(CHANNELS.map((c) => c.name)).toEqual(["sandbox", "webhook", "resend", "slack"]);
  });

  test("a channel is on only when everything it needs is set", () => {
    const real = { DESK_AUTH: "on" };
    expect(configuredChannels({ ...real, NOTIFY_WEBHOOK_URL: ENV.NOTIFY_WEBHOOK_URL }).map((c) => c.name)).toEqual([]); // no secret
    expect(configuredChannels({ ...real, ...ENV }).map((c) => c.name)).toEqual(["webhook"]);
    expect(configuredChannels({ ...real, RESEND_API_KEY: "re_x", NOTIFY_FROM_EMAIL: "desk@example.com" }).map((c) => c.name)).toEqual([]); // no one to send to
    expect(configuredChannels({ ...real, RESEND_API_KEY: "re_x", NOTIFY_FROM_EMAIL: "desk@example.com", NOTIFY_TO_EMAIL: "a@example.com, b@example.com" }).map((c) => c.name)).toEqual(["resend"]);
    expect(configuredChannels({ ...real, SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" }).map((c) => c.name)).toEqual(["slack"]);
    expect(configuredChannels({ ...real, ...ENV, SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" }).map((c) => c.name)).toEqual(["webhook", "slack"]);
  });
});

describe("the signed webhook", () => {
  test("posts the notice as flat JSON with the four facts on top, signed over the timestamp and the body", async () => {
    const { f, calls } = fake(() => new Response("ok", { status: 200 }));
    expect(await webhook.send(notice, ENV, f)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(ENV.NOTIFY_WEBHOOK_URL);
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("error");
    const body = JSON.parse(String(c.init.body));
    expect(body).toMatchObject({ kind: "signal", dedupeKey: notice.dedupeKey, level: "block", loadNumber: "DM-1", unit: "101", dollars: 1250, deskUrl: "https://desk.example.com/loads/l1" });
    expect(headerOf(c, "x-desk-event")).toBe("signal");
    expect(headerOf(c, "x-desk-delivery")).toBe(notice.dedupeKey);
    const ts = headerOf(c, "x-desk-timestamp")!;
    expect(ts).toMatch(/^\d{10}$/);
    const expected = `v1=${createHmac("sha256", ENV.NOTIFY_WEBHOOK_SECRET).update(`${ts}.${String(c.init.body)}`).digest("hex")}`;
    expect(headerOf(c, "x-desk-signature")).toBe(expected);
    expect(sign(ENV.NOTIFY_WEBHOOK_SECRET, ts, String(c.init.body))).toBe(expected);
    // A different secret does not verify.
    expect(sign("another", ts, String(c.init.body))).not.toBe(expected);
  });

  test("https only; http only to this machine and only on the demo desk; no credentials in the address", () => {
    expect(webhookUrlAllowed("https://n8n.example.com/webhook/x", { DESK_AUTH: "on" })).toBe(true);
    expect(webhookUrlAllowed("http://n8n.example.com/webhook/x", {})).toBe(false);
    expect(webhookUrlAllowed("http://localhost:5678/webhook/x", {})).toBe(true);
    expect(webhookUrlAllowed("http://localhost:5678/webhook/x", { DESK_AUTH: "on" })).toBe(false);
    expect(webhookUrlAllowed("https://user:pw@n8n.example.com/x", {})).toBe(false);
    expect(webhookUrlAllowed("ftp://n8n.example.com/x", {})).toBe(false);
    expect(webhookUrlAllowed("not a url", {})).toBe(false);
    expect(webhookUrlAllowed(undefined, {})).toBe(false);
  });

  test("a refused address is never called", async () => {
    const { f, calls } = fake(() => new Response("ok"));
    expect(await webhook.send(notice, { NOTIFY_WEBHOOK_URL: "http://evil.example.com/x", NOTIFY_WEBHOOK_SECRET: "s" }, f)).toEqual({ ok: false, error: "not configured", retry: false });
    expect(calls).toHaveLength(0);
  });

  test("a busy receiver is worth another try; a refusal is not; a timeout or a dropped connection is; and none of it carries the body, the address or the secret", async () => {
    const answers: Array<[() => Response | Promise<Response>, boolean, string]> = [
      [() => new Response("body with SECRET words", { status: 500 }), true, "HTTP 500"],
      [() => new Response("slow down", { status: 429 }), true, "HTTP 429"],
      [() => new Response("no", { status: 401 }), false, "HTTP 401"],
      [() => new Response("gone", { status: 404 }), false, "HTTP 404"],
      [() => Promise.reject(Object.assign(new Error("the host abc123-secret-path timed out"), { name: "TimeoutError" })), true, "timeout"],
      [() => Promise.reject(new Error("ECONNRESET at n8n.example.com/webhook/abc123-secret-path")), true, "network error"]
    ];
    for (const [answer, retry, error] of answers) {
      const { f } = fake(answer);
      const r = await webhook.send(notice, ENV, f);
      expect(r).toEqual({ ok: false, error, retry });
      const said = JSON.stringify(r);
      expect(said).not.toContain("abc123-secret-path");
      expect(said).not.toContain("whsec_top_secret_value");
      expect(said).not.toContain("SECRET words");
    }
  });
});

describe("email through Resend and Slack, dark until set", () => {
  const MAIL = { RESEND_API_KEY: "re_live_key", NOTIFY_FROM_EMAIL: "Desk <desk@example.com>", NOTIFY_TO_EMAIL: "a@example.com, not-an-address, b@example.com" };
  test("Resend: the key, the idempotency key, the valid recipients only, and the words", async () => {
    const { f, calls } = fake(() => new Response("{}", { status: 200 }));
    expect(await resend.send(notice, MAIL, f)).toEqual({ ok: true });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(headerOf(c, "authorization")).toBe("Bearer re_live_key");
    expect(headerOf(c, "idempotency-key")).toBe(notice.dedupeKey);
    expect(JSON.parse(String(c.init.body))).toEqual({ from: "Desk <desk@example.com>", to: ["a@example.com", "b@example.com"], subject: notice.subject, text: notice.text, html: notice.html });
    const { f: bad } = fake(() => new Response("invalid key re_live_key", { status: 403 }));
    const r = await resend.send(notice, MAIL, bad);
    expect(r).toEqual({ ok: false, error: "HTTP 403", retry: false });
    expect(JSON.stringify(r)).not.toContain("re_live_key");
    expect((await resend.send(notice, {}, f)).ok).toBe(false);
  });

  test("Slack: only Slack's own host, the subject in bold above the words", async () => {
    expect(slackUrlAllowed("https://hooks.slack.com/services/T/B/x")).toBe(true);
    expect(slackUrlAllowed("https://hooks.slack.com.evil.example/services/T/B/x")).toBe(false);
    expect(slackUrlAllowed("http://hooks.slack.com/services/T/B/x")).toBe(false);
    expect(slackUrlAllowed("https://n8n.example.com/x")).toBe(false);
    const { f, calls } = fake(() => new Response("ok", { status: 200 }));
    expect(await slack.send(notice, { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" }, f)).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: `*${notice.subject}*\n${notice.text}` });
    const none = fake(() => new Response("ok"));
    expect(await slack.send(notice, { SLACK_WEBHOOK_URL: "https://evil.example.com/x" }, none.f)).toEqual({ ok: false, error: "not configured", retry: false });
    expect(none.calls).toHaveLength(0);
  });
});
