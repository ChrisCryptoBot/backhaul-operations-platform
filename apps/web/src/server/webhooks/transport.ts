import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { DELIVERY_TIMEOUT_MS } from "@/lib/webhook-events";

/**
 * The only code that opens a connection for an outbound webhook (docs/MONEY_PLAN.md, Wave 7 step 3). It connects to the ONE address the caller already checked (src/lib/webhook-target.ts),
 * by overriding the socket's name lookup, so a name that answers differently a moment later (DNS rebinding) cannot move the connection elsewhere. TLS still checks the certificate against
 * the name in the URL (SNI and verification use the host, not the address). Redirects are never followed: a 30x is a failed delivery like any other non-2xx. The answer's body is read up to
 * a small cap and thrown away; only the status is kept.
 */
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
export type SendRequest = { url: URL; address: string; family: 4 | 6; headers: Record<string, string>; body: string; timeoutMs?: number };
export type SendResult = { ok: true; status: number } | { ok: false; error: string };
export type Transport = (r: SendRequest) => Promise<SendResult>;

export const systemResolver: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** A lookup that always answers the pinned address, in whichever form the caller asked for. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_host: string, options: unknown, callback: (...a: unknown[]) => void) => {
    const cb = typeof options === "function" ? (options as (...a: unknown[]) => void) : callback;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

const BODY_CAP = 16 * 1024;

export const pinnedTransport: Transport = (r) =>
  new Promise<SendResult>((resolve) => {
    const mod = r.url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (v: SendResult) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = mod.request(
      r.url,
      {
        method: "POST",
        headers: { ...r.headers, "content-length": String(Buffer.byteLength(r.body, "utf8")) },
        lookup: pinnedLookup(r.address, r.family),
        timeout: r.timeoutMs ?? DELIVERY_TIMEOUT_MS,
        agent: false
      },
      (res) => {
        let seen = 0;
        res.on("data", (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > BODY_CAP) res.destroy();
        });
        res.on("end", () => done({ ok: true, status: res.statusCode ?? 0 }));
        res.on("close", () => done({ ok: true, status: res.statusCode ?? 0 }));
        res.on("error", () => done({ ok: true, status: res.statusCode ?? 0 }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, error: "The receiver did not answer in time." });
    });
    req.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, error: `Could not reach the receiver${e.code ? ` (${e.code})` : ""}.` }));
    req.end(r.body);
  });
