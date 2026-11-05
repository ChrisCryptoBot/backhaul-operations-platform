import { prisma } from "@/lib/db";
import { CAPABILITIES, CAPABILITY_LABEL, PROVIDERS, providerConfigured, resolveProvider, type Capability } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { providerName } from "./call";
import { readersFor, workspaceReader } from "./credentials";
import { newWebhookToken } from "./credentials-core";
import { isOverdue, rhythmOf } from "./sync-policy";

/** Which companies the fleet has connected, and whether the server holds each one's keys. Booleans and words only: a key's name or value is never sent to a screen. */
export type ConnectionRow = {
  capability: Capability;
  label: string;
  provider: string;
  name: string;
  /** The company can be called: every key it needs is set, on the fleet's own account or on the server. */
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: Date | null;
  /** pending | connected | error | revoked, or none when the fleet never connected it. `error` is a run of failed calls, shown with a retry. */
  status: string;
  /** One of our own codes (never the company's words), or null. */
  lastError: string | null;
  failures: number;
  lastSyncedAt: Date | null;
  /** How this kind of company reaches the desk, in a sentence (read on a clock, told by webhook, or asked for). */
  rhythm: string;
  /** A connection that should be read on a clock and has not answered for longer than its rhythm allows. */
  overdue: boolean;
};

const env = (name: string) => process.env[name];

export async function partnerStatus(workspaceId = currentWorkspaceId(), now = new Date()): Promise<ConnectionRow[]> {
  const [rows, readerOf] = await Promise.all([prisma.partnerConnection.findMany({ where: { workspaceId } }), readersFor(workspaceId)]);
  return CAPABILITIES.flatMap((capability) =>
    PROVIDERS[capability].map((provider) => {
      const row = rows.find((r) => r.capability === capability && r.provider === provider);
      const live = row && (row.status === "connected" || row.status === "error") ? row : undefined;
      return {
        capability,
        label: CAPABILITY_LABEL[capability],
        provider,
        name: providerName(provider),
        configured: providerConfigured(provider, readerOf(provider)),
        connected: row?.status === "connected",
        accountLabel: live?.accountLabel ?? null,
        connectedAt: live?.connectedAt ?? null,
        status: row?.status ?? "none",
        lastError: live?.lastError ?? null,
        failures: live?.failures ?? 0,
        lastSyncedAt: live?.lastSyncedAt ?? null,
        rhythm: rhythmOf(capability),
        overdue: row ? isOverdue({ capability, status: row.status, lastSyncedAt: row.lastSyncedAt, connectedAt: row.connectedAt }, now) : false
      };
    })
  );
}

export type ConnectResult = { ok: true; changed: boolean } | { ok: false; error: string };

/** Connect a company for the fleet. Refused until the server holds its keys: a connection to a company that cannot be called would only say "connected" and mean nothing. */
export async function connectPartner(capability: string, provider: string, accountLabel: string | null = null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ConnectResult> {
  if (!(CAPABILITIES as readonly string[]).includes(capability)) return { ok: false, error: "Unknown service." };
  const cap = capability as Capability;
  if (resolveProvider(cap, provider) !== provider) return { ok: false, error: "That company is not one TrueLane works with for this." };
  if (!providerConfigured(provider, await workspaceReader(provider, workspaceId))) return { ok: false, error: `${providerName(provider)} has no keys yet: paste this fleet's own keys, or ask whoever runs the server to set them.` };
  const label = accountLabel?.trim().slice(0, 60) || null;
  const was = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  if (was?.status === "connected" && was.accountLabel === label && was.webhookToken) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.partnerConnection.upsert({
      where: { workspaceId_capability_provider: { workspaceId, capability, provider } },
      update: { status: "connected", accountLabel: label, lastError: null, failures: 0, connectedAt: now, nextSyncAt: now, ...(was?.webhookToken ? {} : { webhookToken: newWebhookToken() }) },
      create: { workspaceId, capability, provider, status: "connected", accountLabel: label, connectedAt: now, nextSyncAt: now, webhookToken: newWebhookToken() }
    });
    await recordAudit({ entity: "partner", action: "partner_connected", summary: `${providerName(provider)} connected for ${CAPABILITY_LABEL[cap].toLowerCase()}`, before: { Connection: was?.status === "connected" ? "Connected" : "Not connected" }, after: { Connection: "Connected", Account: label }, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: true };
}

export async function disconnectPartner(capability: string, provider: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ConnectResult> {
  const was = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  if (!was || was.status !== "connected") return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.partnerConnection.update({ where: { id: was.id }, data: { status: "revoked" } });
    await recordAudit({ entity: "partner", action: "partner_connected", summary: `${providerName(provider)} disconnected for ${(CAPABILITY_LABEL[capability as Capability] ?? capability).toLowerCase()}`, before: { Connection: "Connected" }, after: { Connection: "Not connected" }, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: true };
}

/** After a run of failed calls, try again: the failures are cleared and the schedule asks at once. (If the company is still down the next call counts again.) */
export async function retryConnection(capability: string, provider: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ConnectResult> {
  const row = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  if (!row || (row.status !== "error" && row.status !== "connected")) return { ok: false, error: "That company is not connected." };
  await prisma.partnerConnection.update({ where: { id: row.id }, data: { status: "connected", failures: 0, lastError: null, nextSyncAt: now } });
  return { ok: true, changed: row.status === "error" };
}

/** The path a company is told to post its events to, for this fleet: unguessable, so the fleet is found by it and never by what the body claims. Admin screens only. */
export async function webhookPath(capability: string, provider: string, workspaceId = currentWorkspaceId()): Promise<string | null> {
  const row = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } }, select: { webhookToken: true, status: true } });
  return row?.webhookToken && (row.status === "connected" || row.status === "error") ? `/partners/webhook/${provider}/${row.webhookToken}` : null;
}

/** The webhook path of every connected company, keyed "capability:provider". Admin screens only. */
export async function webhookPaths(workspaceId = currentWorkspaceId()): Promise<Map<string, string>> {
  const rows = await prisma.partnerConnection.findMany({ where: { workspaceId, status: { in: ["connected", "error"] }, webhookToken: { not: null } }, select: { capability: true, provider: true, webhookToken: true } });
  return new Map(rows.map((r) => [`${r.capability}:${r.provider}`, `/partners/webhook/${r.provider}/${r.webhookToken}`]));
}
