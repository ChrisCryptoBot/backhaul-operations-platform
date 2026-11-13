import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { allowed } from "@/lib/partner-gates";
import { SHOWCASE_WORKSPACE_ID } from "@/lib/showcase";
import { effectivePlan } from "@/lib/plans";
import { DEAD_BEFORE_DISABLE, LEASE_MS, MAX_ATTEMPTS, TEST_EVENT, backoffMinutes } from "@/lib/webhook-events";
import { HEADER_EVENT_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, signatureHeader } from "@/lib/webhook-sign";
import { checkAddresses, checkUrl } from "@/lib/webhook-target";
import { credentialKeys, unsealWithKeys } from "@/server/partners/credentials-core";
import { recordAudit } from "@/server/tl/audit";
import { explicitTenancy } from "@/server/tl/workspace";
import { pinnedTransport, systemResolver, type Resolver, type Transport } from "./transport";

/**
 * Delivering the outbox (docs/MONEY_PLAN.md, Wave 7 step 3). Run by the partner schedule (`POST /partners/cron`), and for one row by "Send a test" in Settings. Never inside a money write.
 *
 *   1. Claim: due rows (pending or failed, next attempt reached, not leased) of endpoints that are on, locked with FOR UPDATE SKIP LOCKED and given a short lease in one statement, so two
 *      schedule runs at once never take the same row; a run that dies lets the lease run out and the next run takes the row.
 *   2. Each row inside explicitTenancy(its workspace): the plan, the endpoint's sealed secret, the address checked and resolved with every answer checked, then ONE connection to the checked
 *      address, signed afresh (same event id and body, new timestamp and signature), no redirects.
 *   3. The outcome is written only if this run still holds the lease. 2xx is sent. Anything else waits 5, 15, 60 minutes then six hours; the eighth failure is dead, and three dead in a row
 *      switch the endpoint off (audited). A test event is tried once and never counts against the endpoint.
 */
/** `workspaceId` limits a run to one fleet (the showcase delivers its own rows to its built-in receiver); a run without it never takes the showcase's rows. */
export type DeliverDeps = { now?: Date; transport?: Transport; resolver?: Resolver; production?: boolean; limit?: number; only?: string; workspaceId?: string };
export type DeliverResult = { claimed: number; sent: number; failed: number; dead: number; disabled: number; skipped: number };

type Claimed = { id: string; workspace_id: string; endpoint_id: string; event_id: string; type: string; payload: unknown; attempts: number; lease_until: Date };

const env = () => process.env as Record<string, string | undefined>;
const seconds = (d: Date): number => (d.getTime() - (d.getTime() % 1000)) / 1000;
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

export async function deliverDue(deps: DeliverDeps = {}): Promise<DeliverResult> {
  const now = deps.now ?? new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const limit = deps.limit ?? 50;
  const only = deps.only ? Prisma.sql`AND x."id" = ${deps.only}` : Prisma.empty;
  // The showcase's rows go only to its built-in receiver, delivered by the showcase itself; the schedule leaves them alone.
  const fleet = deps.workspaceId ? Prisma.sql`AND x."workspace_id" = ${deps.workspaceId}` : deps.only ? Prisma.empty : Prisma.sql`AND x."workspace_id" <> ${SHOWCASE_WORKSPACE_ID}`;
  const rows = await prisma.$queryRaw<Claimed[]>`
    UPDATE "webhook_deliveries" d SET "lease_until" = ${lease}
    WHERE d."id" IN (
      SELECT x."id" FROM "webhook_deliveries" x JOIN "webhook_endpoints" e ON e."id" = x."endpoint_id"
      WHERE x."status" IN ('pending', 'failed') AND x."next_attempt_at" <= ${now}
        AND (x."lease_until" IS NULL OR x."lease_until" < ${now})
        AND e."active" AND e."disabled_at" IS NULL ${only} ${fleet}
      ORDER BY x."next_attempt_at", x."id"
      LIMIT ${limit}
      FOR UPDATE OF x SKIP LOCKED)
    RETURNING d."id", d."workspace_id", d."endpoint_id", d."event_id", d."type", d."payload", d."attempts", d."lease_until"`;
  const out: DeliverResult = { claimed: rows.length, sent: 0, failed: 0, dead: 0, disabled: 0, skipped: 0 };
  for (const row of rows) {
    const r = await explicitTenancy(row.workspace_id, () => attempt(row, now, deps));
    out[r] += 1;
  }
  return out;
}

type Outcome = "sent" | "failed" | "dead" | "disabled" | "skipped";

async function attempt(row: Claimed, now: Date, deps: DeliverDeps): Promise<Outcome> {
  const workspaceId = row.workspace_id;
  const held = { id: row.id, leaseUntil: row.lease_until };
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id: row.endpoint_id, workspaceId } });
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  if (!ep || !allowed("outbound_webhooks", effectivePlan(ws?.plan))) {
    // Not this run's to send (the plan no longer has webhooks): put it back for later without counting an attempt.
    await prisma.webhookDelivery.updateMany({ where: held, data: { leaseUntil: null, nextAttemptAt: new Date(now.getTime() + backoffMinutes(4) * 60_000), lastError: "The fleet's plan does not include outbound webhooks." } });
    return "skipped";
  }
  const secret = unsealWithKeys(ep.sealedSecret, credentialKeys(env()))?.values.secret;
  const production = deps.production ?? process.env.NODE_ENV === "production";
  let result: { ok: true; status: number } | { ok: false; error: string };
  if (!secret) result = { ok: false, error: "The signing secret cannot be read on this server. Make a new one in Settings." };
  else {
    const target = checkUrl(ep.url, { production });
    if (!target.ok) result = { ok: false, error: target.error };
    else {
      let pinned: { ok: true; address: string; family: 4 | 6 } | { ok: false; error: string };
      if (target.literal) pinned = { ok: true, address: target.literal, family: target.literal.includes(":") ? 6 : 4 };
      else {
        try {
          pinned = checkAddresses(await (deps.resolver ?? systemResolver)(target.host));
        } catch {
          pinned = { ok: false, error: "The receiver's name does not resolve." };
        }
      }
      if (!pinned.ok) result = { ok: false, error: pinned.error };
      else {
        const body = JSON.stringify(row.payload);
        const t = seconds(now);
        const headers = { "content-type": "application/json", "user-agent": "TrueLane-Webhooks/1", [HEADER_EVENT_ID]: row.event_id, [HEADER_TIMESTAMP]: String(t), [HEADER_SIGNATURE]: signatureHeader(secret, t, body) };
        result = await (deps.transport ?? pinnedTransport)({ url: target.url, address: pinned.address, family: pinned.family, headers, body });
      }
    }
  }

  const tries = row.attempts + 1;
  const good = result.ok && result.status >= 200 && result.status < 300;
  const lastStatus = result.ok ? result.status : null;
  const lastError = good ? null : short(result.ok ? `The receiver answered ${result.status}${result.status >= 300 && result.status < 400 ? " (a redirect, which is not followed)" : ""}.` : result.error);
  if (good) {
    const w = await prisma.webhookDelivery.updateMany({ where: held, data: { status: "sent", sentAt: now, attempts: tries, lastStatus, lastError: null, leaseUntil: null } });
    if (w.count === 1 && row.type !== TEST_EVENT) await prisma.webhookEndpoint.updateMany({ where: { id: ep.id, deadInARow: { gt: 0 } }, data: { deadInARow: 0 } });
    return "sent";
  }
  if (row.type === TEST_EVENT) {
    await prisma.webhookDelivery.updateMany({ where: held, data: { status: "dead", attempts: tries, lastStatus, lastError, leaseUntil: null } });
    return "dead";
  }
  if (tries < MAX_ATTEMPTS) {
    await prisma.webhookDelivery.updateMany({ where: held, data: { status: "failed", attempts: tries, lastStatus, lastError, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + backoffMinutes(tries) * 60_000) } });
    return "failed";
  }
  return prisma.$transaction(async (tx) => {
    const w = await tx.webhookDelivery.updateMany({ where: held, data: { status: "dead", attempts: tries, lastStatus, lastError, leaseUntil: null } });
    if (w.count !== 1) return "dead" as const;
    const e = await tx.webhookEndpoint.update({ where: { id: ep.id }, data: { deadInARow: { increment: 1 } }, select: { deadInARow: true, disabledAt: true, url: true } });
    if (e.deadInARow >= DEAD_BEFORE_DISABLE && !e.disabledAt) {
      const why = `${DEAD_BEFORE_DISABLE} deliveries in a row failed ${MAX_ATTEMPTS} times each. Last: ${lastError ?? "no answer"}`;
      await tx.webhookEndpoint.update({ where: { id: ep.id }, data: { disabledAt: now, disabledReason: short(why) } });
      await recordAudit({ entity: "partner", entityId: ep.id, action: "webhook_endpoint_switched", summary: `Webhook to ${hostOf(e.url)} switched off by TrueLane: ${short(why)}`, before: { Webhook: "On" }, after: { Webhook: "Off" }, at: now, workspaceId, actor: "TrueLane" }, tx);
      return "disabled" as const;
    }
    return "dead" as const;
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an address";
  }
}
