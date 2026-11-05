import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { SECRET_ENV, WEBHOOK_SECRET_ENV, type EnvReader } from "@/truelane/partners/contract";
import { checkCredential, credentialKey, hintOf, seal, unseal } from "./credentials-core";

/**
 * Per-workspace partner keys (docs/PARTNER_BACKBONE.md). A fleet's own key for a company is sealed in `partner_credentials`; the server's own environment keys remain as the fallback, so a
 * deployment that holds one company account for everyone keeps working. What a call reads is the fleet's key first, then the server's, by secret name.
 *
 * Nothing here returns a secret to a screen or a log: `credentialStatus` returns names, whether each is set, where it comes from, and a last-four hint; `workspaceReader` returns values only
 * to server code that is about to call the company.
 */
const env = (name: string) => process.env[name];

/** Whether this server can seal keys at all (`DESK_CREDENTIAL_KEY` is set and is a real 32-byte key). Without it a fleet cannot store its own keys and the connect form says so. */
export const credentialsAvailable = (): boolean => credentialKey(process.env as Record<string, string | undefined>) != null;

/** Every secret a provider takes: its API keys and its webhook signing secret, by name. */
export const fieldsOf = (provider: string): string[] => [...(SECRET_ENV[provider] ?? []), ...(WEBHOOK_SECRET_ENV[provider] ? [WEBHOOK_SECRET_ENV[provider]!] : [])];

async function storedValues(workspaceId: string, provider: string): Promise<Record<string, string>> {
  const key = credentialKey(process.env as Record<string, string | undefined>);
  if (!key) return {};
  const row = await prisma.partnerCredential.findUnique({ where: { workspaceId_provider: { workspaceId, provider } }, select: { sealed: true } });
  return (row ? unseal(row.sealed, key) : null) ?? {};
}

/** A reader for one fleet and one company: its own key by name, else the server's. For server code about to call the company (or check that it could). */
export async function workspaceReader(provider: string, workspaceId = currentWorkspaceId()): Promise<EnvReader> {
  const mine = await storedValues(workspaceId, provider);
  return (name) => mine[name] ?? env(name);
}

/** A reader per company for one fleet, from one read of its sealed keys: for a screen that must say, for every company, whether it could be called. */
export async function readersFor(workspaceId = currentWorkspaceId()): Promise<(provider: string) => EnvReader> {
  const key = credentialKey(process.env as Record<string, string | undefined>);
  const rows = key ? await prisma.partnerCredential.findMany({ where: { workspaceId }, select: { provider: true, sealed: true } }) : [];
  const mine = new Map(rows.map((r) => [r.provider, unseal(r.sealed, key!) ?? {}]));
  return (provider) => (name) => mine.get(provider)?.[name] ?? env(name);
}

export type FieldStatus = { name: string; set: boolean; hint: string | null; from: "fleet" | "server" | null };

/** What the connect screen may say about a company's keys: which are set, where they come from, and the last four characters of the fleet's own. */
export async function credentialStatus(provider: string, workspaceId = currentWorkspaceId()): Promise<FieldStatus[]> {
  const row = await prisma.partnerCredential.findUnique({ where: { workspaceId_provider: { workspaceId, provider } }, select: { hints: true } });
  const hints = (row?.hints ?? {}) as Record<string, string>;
  return fieldsOf(provider).map((name) => {
    if (hints[name]) return { name, set: true, hint: hints[name]!, from: "fleet" as const };
    if ((env(name) ?? "").trim() !== "") return { name, set: true, hint: null, from: "server" as const };
    return { name, set: false, hint: null, from: null };
  });
}

export type SaveCredentialResult = { ok: true; changed: string[] } | { ok: false; error: string };

/** Seal and store a fleet's keys for a company. A blank field keeps what is there. Audited by field name only: no value, no hint, goes into the trail. */
export async function saveCredential(provider: string, raw: Record<string, unknown>, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveCredentialResult> {
  if (!SECRET_ENV[provider]) return { ok: false, error: "That is not a company TrueLane works with." };
  const key = credentialKey(process.env as Record<string, string | undefined>);
  if (!key) return { ok: false, error: "This server cannot keep a fleet's own keys yet (no credential key is set). Ask whoever runs the server." };
  const check = checkCredential(raw, fieldsOf(provider));
  if (!check.ok) return check;
  const merged = { ...(await storedValues(workspaceId, provider)), ...check.values };
  const hints = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, hintOf(v)]));
  const sealed = seal(merged, key);
  await prisma.$transaction(async (tx) => {
    await tx.partnerCredential.upsert({ where: { workspaceId_provider: { workspaceId, provider } }, update: { sealed, hints }, create: { workspaceId, provider, sealed, hints } });
    await recordAudit({ entity: "partner", action: "partner_credentials_saved", summary: `Keys saved for ${provider}: ${Object.keys(check.values).join(", ")}`, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: Object.keys(check.values) };
}

/** Forget a fleet's own keys for a company (the server's own, if any, remain). */
export async function deleteCredential(provider: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<boolean> {
  const out = await prisma.partnerCredential.deleteMany({ where: { workspaceId, provider } });
  if (out.count === 0) return false;
  await recordAudit({ entity: "partner", action: "partner_credentials_saved", summary: `Keys removed for ${provider}`, at: now, workspaceId });
  return true;
}

/** Every company's key status for the fleet in one read: for the connect screen. Names, whether each is set, where from, and the fleet's own last-four hints; never a value. */
export async function allCredentialStatus(workspaceId = currentWorkspaceId()): Promise<Map<string, FieldStatus[]>> {
  const rows = await prisma.partnerCredential.findMany({ where: { workspaceId }, select: { provider: true, hints: true } });
  const hintsOf = new Map(rows.map((r) => [r.provider, (r.hints ?? {}) as Record<string, string>]));
  const out = new Map<string, FieldStatus[]>();
  for (const provider of Object.keys(SECRET_ENV)) {
    const hints = hintsOf.get(provider) ?? {};
    out.set(
      provider,
      fieldsOf(provider).map((name): FieldStatus => (hints[name] ? { name, set: true, hint: hints[name]!, from: "fleet" } : (env(name) ?? "").trim() !== "" ? { name, set: true, hint: null, from: "server" } : { name, set: false, hint: null, from: null }))
    );
  }
  return out;
}
