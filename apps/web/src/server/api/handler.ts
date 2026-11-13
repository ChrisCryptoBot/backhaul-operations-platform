import { randomBytes } from "node:crypto";
import { RATE_LIMIT, decodeCursor, readLimit, type ApiScope } from "@/lib/api-keys";
import { explicitTenancy } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { authenticate } from "./keys";
import { READERS } from "./reads";

/**
 * One GET of the partner read API (`/api/v1/<scope>`). The order is fixed and every refusal is JSON with a request id:
 *   1-7. authenticate(): Bearer header, key shape, row by prefix, constant-time hash, not revoked, scope, plan, rate window (src/server/api/keys.ts);
 *   8.   the page parameters (limit 1..100, an `after` cursor this API gave out);
 *   9.   the read, inside explicitTenancy(workspace) so nothing it calls can fall back to a person's or the demo's workspace, with the workspace passed to it explicitly.
 * No cookie, session or sign-in provider is read anywhere on this path. A failure inside the read answers 500 with the request id and no detail.
 */
export type ApiDeps = { now?: () => Date };

const requestId = () => `req_${randomBytes(12).toString("hex")}`;

function json(status: number, body: unknown, rid: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": rid, ...extra } });
}

const problem = (status: number, code: string, message: string, rid: string, extra: Record<string, string> = {}) => json(status, { error: { code, message }, request_id: rid }, rid, extra);

export async function serveRead(req: Request, scope: ApiScope, deps: ApiDeps = {}): Promise<Response> {
  const rid = requestId();
  const now = deps.now?.() ?? new Date();
  try {
    const auth = await authenticate(req.headers.get("authorization"), scope, now);
    if (!auth.ok) {
      const extra: Record<string, string> = {};
      if (auth.status === 401) extra["www-authenticate"] = 'Bearer realm="truelane"';
      if (auth.retryAfter != null) {
        extra["retry-after"] = String(auth.retryAfter);
        extra["x-ratelimit-limit"] = String(RATE_LIMIT);
        extra["x-ratelimit-remaining"] = "0";
      }
      return problem(auth.status, auth.code, auth.message, rid, extra);
    }
    const rate = { "x-ratelimit-limit": String(RATE_LIMIT), "x-ratelimit-remaining": String(Math.max(0, auth.remaining)) };
    const q = new URL(req.url).searchParams;
    const limit = readLimit(q.get("limit"));
    if (!limit.ok) return problem(400, "bad_request", limit.error, rid, rate);
    const after = decodeCursor(q.get("after"));
    if (!after.ok) return problem(400, "bad_request", after.error, rid, rate);

    const workspaceId = auth.workspaceId;
    const body = await explicitTenancy(workspaceId, async () => {
      const [timezone, out] = await Promise.all([workspaceTimezone(workspaceId), READERS[scope](workspaceId, { after: after.cursor, limit: limit.limit })]);
      return { object: "list", data: out.data, has_more: out.next != null, next_cursor: out.next, timezone, request_id: rid };
    });
    return json(200, body, rid, rate);
  } catch {
    return problem(500, "server_error", "Something went wrong on our side. Quote the request id if you ask about it.", rid);
  }
}
