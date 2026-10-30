import { prisma } from "@/lib/db";
import { CAPABILITIES, CAPABILITY_LABEL, PROVIDERS, providerConfigured, resolveProvider, type Capability } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { providerName } from "./call";

/** Which companies the fleet has connected, and whether the server holds each one's keys. Booleans and words only: a key's name or value is never sent to a screen. */
export type ConnectionRow = { capability: Capability; label: string; provider: string; name: string; configured: boolean; connected: boolean; accountLabel: string | null; connectedAt: Date | null };

const env = (name: string) => process.env[name];

export async function partnerStatus(workspaceId = currentWorkspaceId()): Promise<ConnectionRow[]> {
  const rows = await prisma.partnerConnection.findMany({ where: { workspaceId } });
  return CAPABILITIES.flatMap((capability) =>
    PROVIDERS[capability].map((provider) => {
      const row = rows.find((r) => r.capability === capability && r.provider === provider && r.status === "connected");
      return { capability, label: CAPABILITY_LABEL[capability], provider, name: providerName(provider), configured: providerConfigured(provider, env), connected: !!row, accountLabel: row?.accountLabel ?? null, connectedAt: row?.connectedAt ?? null };
    })
  );
}

export type ConnectResult = { ok: true; changed: boolean } | { ok: false; error: string };

/** Connect a company for the fleet. Refused until the server holds its keys: a connection to a company that cannot be called would only say "connected" and mean nothing. */
export async function connectPartner(capability: string, provider: string, accountLabel: string | null = null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ConnectResult> {
  if (!(CAPABILITIES as readonly string[]).includes(capability)) return { ok: false, error: "Unknown service." };
  const cap = capability as Capability;
  if (resolveProvider(cap, provider) !== provider) return { ok: false, error: "That company is not one TrueLane works with for this." };
  if (!providerConfigured(provider, env)) return { ok: false, error: `${providerName(provider)} has no keys on the server yet.` };
  const label = accountLabel?.trim().slice(0, 60) || null;
  const was = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  if (was?.status === "connected" && was.accountLabel === label) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.partnerConnection.upsert({
      where: { workspaceId_capability_provider: { workspaceId, capability, provider } },
      update: { status: "connected", accountLabel: label, lastError: null, connectedAt: now },
      create: { workspaceId, capability, provider, status: "connected", accountLabel: label, connectedAt: now }
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
