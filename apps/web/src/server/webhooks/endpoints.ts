import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { EVENT_LABEL, TEST_EVENT, cleanEndpointInput, type WebhookEvent } from "@/lib/webhook-events";
import { SECRET_PREFIX } from "@/lib/webhook-sign";
import { checkAddresses, checkUrl } from "@/lib/webhook-target";
import { checkFeature } from "@/server/partners/gates";
import { credentialKey, seal } from "@/server/partners/credentials-core";
import { recordAudit } from "@/server/tl/audit";
import { deliverDue, hostOf, type DeliverDeps } from "./deliver";
import { envelope, newEventId } from "./emit";
import { systemResolver, type Resolver } from "./transport";

/**
 * A fleet's webhook endpoints (docs/MONEY_PLAN.md, Wave 7 step 3): made, switched on and off, given a new secret, and tested by an admin, on a plan with outbound webhooks. Every function takes
 * the workspace explicitly. The signing secret is made here, sealed like a partner key (credentials-core.ts, rotated by the same schedule), and returned once; a screen sees its last four.
 */
const env = () => process.env as Record<string, string | undefined>;
export const MAX_ENDPOINTS = 10;
const nameOf = (who: string) => who.trim().slice(0, 120) || "Admin";
const newSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
type Deps = { resolver?: Resolver; production?: boolean };

/** The address is checked now as well as at every send: the same rules, and the name resolved with every answer checked. */
async function checkTarget(raw: string, deps: Deps): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const c = checkUrl(raw, { production: deps.production ?? process.env.NODE_ENV === "production" });
  if (!c.ok) return c;
  if (!c.literal) {
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await (deps.resolver ?? systemResolver)(c.host);
    } catch {
      return { ok: false, error: "That address's name does not resolve. Check it, or set the receiver up first." };
    }
    const a = checkAddresses(answers);
    if (!a.ok) return a;
  }
  return { ok: true, url: c.url.toString() };
}

export type MadeEndpoint = { ok: true; id: string; secret: string } | { ok: false; error: string };

export async function createEndpoint(input: { url: unknown; label: unknown; events: unknown }, who: string, now: Date, workspaceId: string, deps: Deps = {}): Promise<MadeEndpoint> {
  const plan = await checkFeature("outbound_webhooks", workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const key = credentialKey(env());
  if (!key) return { ok: false, error: "This server cannot keep a signing secret yet (no credential key is set). Ask whoever runs the server." };
  const clean = cleanEndpointInput(input);
  if (!clean.ok) return clean;
  const target = await checkTarget(clean.url, deps);
  if (!target.ok) return target;
  const secret = newSecret();
  const name = nameOf(who);
  const id = await prisma.$transaction(async (tx) => {
    if ((await tx.webhookEndpoint.count({ where: { workspaceId } })) >= MAX_ENDPOINTS) return null;
    const row = await tx.webhookEndpoint.create({ data: { workspaceId, url: target.url, label: clean.label, events: clean.events, sealedSecret: seal({ secret }, key), secretLast4: secret.slice(-4), createdBy: name, createdAt: now } });
    await recordAudit(
      { entity: "partner", entityId: row.id, action: "webhook_endpoint_created", summary: `Webhook to ${hostOf(target.url)} made by ${name}: ${clean.events.length} ${clean.events.length === 1 ? "event" : "events"} (${clean.events.join(", ")})`, after: { Webhook: hostOf(target.url), Events: clean.events.join(", ") }, at: now, workspaceId },
      tx
    );
    return row.id;
  });
  if (!id) return { ok: false, error: `This fleet already has ${MAX_ENDPOINTS} webhook addresses.` };
  return { ok: true, id, secret };
}

export async function rotateEndpointSecret(id: string, who: string, now: Date, workspaceId: string): Promise<MadeEndpoint> {
  const plan = await checkFeature("outbound_webhooks", workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const key = credentialKey(env());
  if (!key) return { ok: false, error: "This server cannot keep a signing secret yet (no credential key is set)." };
  const secret = newSecret();
  const name = nameOf(who);
  return prisma.$transaction(async (tx) => {
    const ep = await tx.webhookEndpoint.findFirst({ where: { id, workspaceId } });
    if (!ep) return { ok: false as const, error: "That webhook does not exist." };
    await tx.webhookEndpoint.update({ where: { id }, data: { sealedSecret: seal({ secret }, key), secretLast4: secret.slice(-4) } });
    await recordAudit({ entity: "partner", entityId: id, action: "webhook_secret_rotated", summary: `Webhook to ${hostOf(ep.url)}: new signing secret made by ${name} (the old one stops working now)`, before: { Secret: `…${ep.secretLast4}` }, after: { Secret: `…${secret.slice(-4)}` }, at: now, workspaceId }, tx);
    return { ok: true as const, id, secret };
  });
}

export type SwitchedEndpoint = { ok: true; changed: boolean } | { ok: false; error: string };

/** Switch an endpoint on (the plan must have webhooks; it starts with a clean count) or off (always allowed). */
export async function setEndpointActive(id: string, on: boolean, who: string, now: Date, workspaceId: string): Promise<SwitchedEndpoint> {
  if (on) {
    const plan = await checkFeature("outbound_webhooks", workspaceId);
    if (!plan.ok) return { ok: false, error: plan.error };
  }
  const name = nameOf(who);
  return prisma.$transaction(async (tx) => {
    const ep = await tx.webhookEndpoint.findFirst({ where: { id, workspaceId } });
    if (!ep) return { ok: false as const, error: "That webhook does not exist." };
    const isOn = ep.active && !ep.disabledAt;
    if (isOn === on) return { ok: true as const, changed: false };
    await tx.webhookEndpoint.update({ where: { id }, data: on ? { active: true, disabledAt: null, disabledReason: null, deadInARow: 0 } : { active: false } });
    await recordAudit({ entity: "partner", entityId: id, action: "webhook_endpoint_switched", summary: `Webhook to ${hostOf(ep.url)} switched ${on ? "on" : "off"} by ${name}`, before: { Webhook: isOn ? "On" : "Off" }, after: { Webhook: on ? "On" : "Off" }, at: now, workspaceId }, tx);
    return { ok: true as const, changed: true };
  });
}

export type TestResult = { ok: true; delivered: boolean; status: number | null; error: string | null } | { ok: false; error: string };

/** Send a test event to one endpoint now: queued like any event (so it is signed and checked the same way) and delivered at once. It never counts against the endpoint. */
export async function sendTestEvent(id: string, who: string, now: Date, workspaceId: string, deps: DeliverDeps = {}): Promise<TestResult> {
  const plan = await checkFeature("outbound_webhooks", workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const ep = await prisma.webhookEndpoint.findFirst({ where: { id, workspaceId } });
  if (!ep) return { ok: false, error: "That webhook does not exist." };
  if (!ep.active || ep.disabledAt) return { ok: false, error: "Switch the webhook on first." };
  const eventId = newEventId();
  const name = nameOf(who);
  const row = await prisma.$transaction(async (tx) => {
    const d = await tx.webhookDelivery.create({ data: { workspaceId, endpointId: id, eventId, type: TEST_EVENT, payload: envelope(eventId, TEST_EVENT, { message: "A test from TrueLane. Nothing changed." }, now) as Prisma.InputJsonObject, nextAttemptAt: now, createdAt: now } });
    await recordAudit({ entity: "partner", entityId: id, action: "webhook_test_sent", summary: `Test event sent to the webhook at ${hostOf(ep.url)} by ${name}`, at: now, workspaceId }, tx);
    return d;
  });
  await deliverDue({ ...deps, now, only: row.id, limit: 1 });
  const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
  return { ok: true, delivered: after.status === "sent", status: after.lastStatus, error: after.lastError };
}

export type EndpointRow = { id: string; url: string; label: string | null; events: WebhookEvent[]; secretLast4: string; on: boolean; disabledAt: Date | null; disabledReason: string | null; deadInARow: number; createdBy: string | null; createdAt: Date };
export type DeliveryRow = { id: string; endpointId: string; eventId: string; type: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: Date; sentAt: Date | null; nextAttemptAt: Date };

/** What a screen may say about a fleet's endpoints and its latest deliveries: never a secret or a body. */
export async function listWebhooks(workspaceId: string, take = 15): Promise<{ endpoints: EndpointRow[]; deliveries: DeliveryRow[] }> {
  const [eps, dels] = await Promise.all([
    prisma.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    prisma.webhookDelivery.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: { id: true, endpointId: true, eventId: true, type: true, status: true, attempts: true, lastStatus: true, lastError: true, createdAt: true, sentAt: true, nextAttemptAt: true } })
  ]);
  return {
    endpoints: eps.map((e) => ({ id: e.id, url: e.url, label: e.label, events: e.events.filter((x): x is WebhookEvent => x in EVENT_LABEL), secretLast4: e.secretLast4, on: e.active && !e.disabledAt, disabledAt: e.disabledAt, disabledReason: e.disabledReason, deadInARow: e.deadInARow, createdBy: e.createdBy, createdAt: e.createdAt })),
    deliveries: dels
  };
}
