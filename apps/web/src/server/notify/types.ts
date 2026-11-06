import type { Notice } from "@/lib/notify";

/**
 * A way a notice leaves the desk. Every channel is dark until the server holds what it needs (its variables, named in docs/ENVIRONMENT.md); none is ever configured from a form, so an address a
 * person types can never become somewhere the server posts to. The network is reached only through the `fetch` handed in, so tests use a fake and no test touches the network.
 */
export type Env = Record<string, string | undefined>;
export type ChannelName = "sandbox" | "webhook" | "resend" | "slack";
export type Fetch = typeof fetch;

/** `retry` says whether trying again can help: a refused key cannot be fixed by waiting, a busy server can. `error` is a few words, never a body, a key or an address. */
export type SendResult = { ok: true } | { ok: false; error: string; retry: boolean };

export interface Channel {
  name: ChannelName;
  /** Whether the server holds everything this channel needs. */
  configured(env: Env): boolean;
  send(notice: Notice, env: Env, fetchFn: Fetch): Promise<SendResult>;
}

/** The answer for a response that was not a success, in words that carry no body. */
export function failureOf(status: number): SendResult {
  return { ok: false, error: `HTTP ${status}`, retry: status === 408 || status === 425 || status === 429 || status >= 500 };
}

/** A send that threw: a timeout or a network error, both worth another try. */
export function thrownOf(e: unknown): SendResult {
  const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return { ok: false, error: timedOut ? "timeout" : "network error", retry: true };
}

export const SEND_TIMEOUT_MS = 5_000;
