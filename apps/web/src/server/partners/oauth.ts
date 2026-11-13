import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { OAUTH_PROVIDERS, REFRESH_LEASE_MS, STATE_TTL_MS, authorizeUrl, callbackPath, cleanAccountId, needsRefresh } from "@/lib/oauth";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { CAPABILITY_LABEL, providerConfigured } from "@/truelane/partners/contract";
import { liveExchanger, sandboxExchanger, type OAuthExchanger } from "./adapters/oauth-exchange";
import { keyMode } from "./adapters/sandbox";
import { providerName } from "./call";
import { credentialKey, credentialKeys, newWebhookToken, seal, unsealWithKeys } from "./credentials-core";
import { workspaceReader } from "./credentials";
import { capabilityOf } from "./setup";
import { disconnectPartner } from "./connections";
import { checkFeature } from "./gates";

/**
 * A fleet's OAuth sign-in to a partner company (QuickBooks Online first; docs/MONEY_PLAN.md, Wave 3), beside the pasted keys of credentials.ts.
 *
 *   beginOAuth     makes a one-time state (only its SHA-256 is kept, for ten minutes) and answers the address to send the person to.
 *   completeOAuth  the callback: the state must be this fleet's, unused and in time; the code is traded for tokens, which are sealed (AES-256-GCM, as keys are) with the company's id for the
 *                  account, and the connection is made, in one transaction, audited.
 *   accessTokenFor what server code calls before talking to the company: the access token, refreshed first when it is within five minutes of running out. A refresh is claimed by
 *                  compare-and-set on the row's version with a 30-second lease, so two calls never spend the same refresh token (QuickBooks replaces it on each use); the call that loses
 *                  waits for the winner's token. A refresh the company refuses for good marks the sign-in expired and the connection in error: the fleet signs in again.
 * No token ever reaches a screen, a log or the audit trail.
 */
const env = () => process.env as Record<string, string | undefined>;
const hashOf = (state: string) => createHash("sha256").update(state).digest("hex");
const exchangerFor = (mode: "live" | "sandbox"): OAuthExchanger => (mode === "sandbox" ? sandboxExchanger : liveExchanger);

type Fail = { ok: false; error: string };

/** Whether the app's keys for the company are set (the fleet's own, else the server's), and which way calls go: the company, or the simulator. */
async function readiness(provider: string, workspaceId: string): Promise<{ ok: true; clientId: string; mode: "live" | "sandbox" } | Fail> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return { ok: false, error: "That company does not connect by signing in." };
  const reader = await workspaceReader(provider, workspaceId);
  if (!providerConfigured(provider, reader)) return { ok: false, error: `${providerName(provider)} is not set up on this server yet: its app keys are missing. Ask whoever runs the server.` };
  if (!credentialKey(env())) return { ok: false, error: "This server cannot keep a sign-in yet (no credential key is set). Ask whoever runs the server." };
  const mode = keyMode(provider, reader);
  if (mode === "refused") return { ok: false, error: "A key that starts with sandbox_ runs the built-in simulator, which is only on the demo desk. Use the company's real key." };
  return { ok: true, clientId: reader(def.clientIdEnv)!.trim(), mode };
}

export type BeginResult = { ok: true; url: string } | Fail;

/** The address to send the person to, to sign in to the company. `origin` is this desk's own address (the callback is registered with the company under it). */
export async function beginOAuth(provider: string, opts: { origin: string; who?: string | null }, now = new Date(), workspaceId = currentWorkspaceId(), exchanger?: OAuthExchanger): Promise<BeginResult> {
  const ready = await readiness(provider, workspaceId);
  if (!ready.ok) return ready;
  const plan = await checkFeature(capabilityOf(provider)!, workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const def = OAUTH_PROVIDERS[provider]!;
  const ex = exchanger ?? exchangerFor(ready.mode);
  if (ex === liveExchanger) return { ok: false, error: `${providerName(provider)} is not connected to TrueLane yet: its live sign-in is written when the company gives TrueLane access.` };
  const state = randomBytes(32).toString("base64url");
  // Old sign-ins that were never finished are dropped as new ones start: nothing reads them after they expire.
  await prisma.partnerOAuthState.deleteMany({ where: { workspaceId, expiresAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
  await prisma.partnerOAuthState.create({ data: { workspaceId, provider, stateHash: hashOf(state), expiresAt: new Date(now.getTime() + STATE_TTL_MS), createdBy: opts.who?.slice(0, 120) ?? null } });
  const redirectUri = `${opts.origin.replace(/\/+$/, "")}${callbackPath(provider)}`;
  return { ok: true, url: ex.signInUrl({ provider, clientId: ready.clientId, redirectUri, state, companyUrl: authorizeUrl(def, { clientId: ready.clientId, redirectUri, state }) }) };
}

export type CompleteResult = { ok: true; accountId: string } | Fail;

/** The callback. Everything it is given comes from the person's browser, so every part is checked before anything is written. */
export async function completeOAuth(
  provider: string,
  q: { state?: string | null; code?: string | null; accountId?: string | null; error?: string | null },
  opts: { origin: string; who?: string | null },
  now = new Date(),
  workspaceId = currentWorkspaceId(),
  exchanger?: OAuthExchanger
): Promise<CompleteResult> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return { ok: false, error: "That company does not connect by signing in." };
  const state = typeof q.state === "string" && q.state.length >= 20 && q.state.length <= 200 ? q.state : null;
  if (!state) return { ok: false, error: "The sign-in came back without its check. Start again from Settings." };
  const row = await prisma.partnerOAuthState.findUnique({ where: { stateHash: hashOf(state) } });
  if (!row || row.provider !== provider || row.workspaceId !== workspaceId) return { ok: false, error: "That sign-in was not started from this desk. Start again from Settings." };
  // Used once: whatever happens next, this state cannot be played again.
  const claimed = await prisma.partnerOAuthState.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count === 0) return { ok: false, error: "That sign-in was already used. Start again from Settings." };
  if (row.expiresAt.getTime() < now.getTime()) return { ok: false, error: "That sign-in took too long. Start again from Settings." };
  if (q.error) return { ok: false, error: `The sign-in was not completed at ${providerName(provider)}.` };
  const code = typeof q.code === "string" && q.code.length > 0 && q.code.length <= 2048 ? q.code : null;
  const accountId = def.accountParam ? cleanAccountId(q.accountId) : "default";
  if (!code || !accountId) return { ok: false, error: `${providerName(provider)} did not send back what the desk needs. Start again from Settings.` };

  const ready = await readiness(provider, workspaceId);
  if (!ready.ok) return ready;
  const plan = await checkFeature(capabilityOf(provider)!, workspaceId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const ex = exchanger ?? exchangerFor(ready.mode);
  const redirectUri = `${opts.origin.replace(/\/+$/, "")}${callbackPath(provider)}`;
  const traded = await ex.exchangeCode({ provider, code, redirectUri }, now);
  if (!traded.ok) return { ok: false, error: traded.message ?? `${providerName(provider)} did not accept the sign-in.` };
  const t = traded.data;
  const sealed = seal({ access_token: t.accessToken, refresh_token: t.refreshToken }, credentialKey(env())!);
  const capability = capabilityOf(provider)!;
  const was = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability, provider } } });
  await prisma.$transaction(async (tx) => {
    const fields = { accountId, sealed, scope: t.scope, accessExpiresAt: t.accessExpiresAt, refreshExpiresAt: t.refreshExpiresAt, refreshingUntil: null, refreshedAt: now, status: "active", lastError: null, connectedBy: opts.who?.slice(0, 120) ?? null };
    // A new sign-in moves the version on, so a refresh another call started on the old tokens cannot overwrite these.
    await tx.partnerOAuthToken.upsert({ where: { workspaceId_provider: { workspaceId, provider } }, update: { ...fields, version: { increment: 1 } }, create: { workspaceId, provider, ...fields } });
    await tx.partnerConnection.upsert({
      where: { workspaceId_capability_provider: { workspaceId, capability, provider } },
      update: { status: "connected", lastError: null, failures: 0, connectedAt: now, nextSyncAt: now, ...(was?.webhookToken ? {} : { webhookToken: newWebhookToken() }) },
      create: { workspaceId, capability, provider, status: "connected", connectedAt: now, nextSyncAt: now, webhookToken: newWebhookToken() }
    });
    await recordAudit({ entity: "partner", action: "partner_connected", summary: `${providerName(provider)} signed in for ${CAPABILITY_LABEL[capability].toLowerCase()} (company ${accountId})`, before: { Connection: was?.status === "connected" ? "Connected" : "Not connected" }, after: { Connection: "Connected", Company: accountId }, at: now, workspaceId }, tx);
  });
  return { ok: true, accountId };
}

export type TokenResult = { ok: true; accessToken: string; accountId: string } | { ok: false; code: "not_connected" | "expired" | "busy" | "failed"; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The access token for a call to the company, refreshed first when it is near its end. For server code only: the token goes to the company and nowhere else. */
export async function accessTokenFor(provider: string, now = new Date(), workspaceId = currentWorkspaceId(), opts: { exchanger?: OAuthExchanger; waitMs?: number } = {}): Promise<TokenResult> {
  const name = providerName(provider);
  const row = await prisma.partnerOAuthToken.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!row) return { ok: false, code: "not_connected", error: `${name} is not signed in on this desk.` };
  if (row.status === "expired") return { ok: false, code: "expired", error: `The sign-in to ${name} has run out. Sign in again from Settings.` };
  const opened = unsealWithKeys(row.sealed, credentialKeys(env()));
  const access = opened?.values.access_token;
  const refreshToken = opened?.values.refresh_token;
  if (!access || !refreshToken) return { ok: false, code: "expired", error: `The sign-in to ${name} cannot be read on this server. Sign in again from Settings.` };
  if (!needsRefresh(row.accessExpiresAt, now)) return { ok: true, accessToken: access, accountId: row.accountId };
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now.getTime()) {
    await expire(row.id, provider, workspaceId, "The refresh token ran out.");
    return { ok: false, code: "expired", error: `The sign-in to ${name} has run out. Sign in again from Settings.` };
  }

  const claim = await prisma.partnerOAuthToken.updateMany({
    where: { id: row.id, version: row.version, OR: [{ refreshingUntil: null }, { refreshingUntil: { lt: now } }] },
    data: { version: row.version + 1, refreshingUntil: new Date(now.getTime() + REFRESH_LEASE_MS) }
  });
  if (claim.count === 0) return waitForOther(provider, row.version, now, workspaceId, opts.waitMs ?? 5000);

  const reader = await workspaceReader(provider, workspaceId);
  const mode = keyMode(provider, reader);
  const ex = opts.exchanger ?? exchangerFor(mode === "sandbox" ? "sandbox" : "live");
  const out = await ex.refresh({ provider, refreshToken }, now);
  if (!out.ok) {
    if (out.revoked) {
      await expire(row.id, provider, workspaceId, out.message ?? "The company refused the refresh token.");
      return { ok: false, code: "expired", error: `${name} refused the sign-in. Sign in again from Settings.` };
    }
    await prisma.partnerOAuthToken.updateMany({ where: { id: row.id, version: row.version + 1 }, data: { refreshingUntil: null, lastError: (out.message ?? out.code).slice(0, 300) } });
    // The old access token may still have a few minutes in it: use it rather than fail the call.
    if (row.accessExpiresAt.getTime() > now.getTime()) return { ok: true, accessToken: access, accountId: row.accountId };
    return { ok: false, code: "failed", error: `${name} could not be reached to renew the sign-in. Try again shortly.` };
  }
  const t = out.data;
  const saved = await prisma.partnerOAuthToken.updateMany({
    where: { id: row.id, version: row.version + 1 },
    data: { sealed: seal({ access_token: t.accessToken, refresh_token: t.refreshToken }, credentialKey(env())!), accessExpiresAt: t.accessExpiresAt, refreshExpiresAt: t.refreshExpiresAt ?? row.refreshExpiresAt, scope: t.scope ?? row.scope, refreshingUntil: null, refreshedAt: now, lastError: null }
  });
  // A new sign-in landed while this refresh was out: that one stands, and is what the call uses.
  if (saved.count === 0) return waitForOther(provider, row.version, now, workspaceId, 0);
  return { ok: true, accessToken: t.accessToken, accountId: row.accountId };
}

/** Another call holds the refresh: wait for its token (up to `waitMs`), reading the row again. */
async function waitForOther(provider: string, seenVersion: number, now: Date, workspaceId: string, waitMs: number): Promise<TokenResult> {
  for (let waited = 0; ; waited += 200) {
    const row = await prisma.partnerOAuthToken.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
    if (!row) return { ok: false, code: "not_connected", error: `${providerName(provider)} is not signed in on this desk.` };
    if (row.status === "expired") return { ok: false, code: "expired", error: `The sign-in to ${providerName(provider)} has run out. Sign in again from Settings.` };
    if (row.version !== seenVersion && row.refreshingUntil == null && !needsRefresh(row.accessExpiresAt, now)) {
      const access = unsealWithKeys(row.sealed, credentialKeys(env()))?.values.access_token;
      if (access) return { ok: true, accessToken: access, accountId: row.accountId };
    }
    if (waited >= waitMs) return { ok: false, code: "busy", error: `The sign-in to ${providerName(provider)} is being renewed. Try again in a moment.` };
    await sleep(200);
  }
}

async function expire(id: string, provider: string, workspaceId: string, why: string): Promise<void> {
  const capability = capabilityOf(provider);
  await prisma.$transaction(async (tx) => {
    await tx.partnerOAuthToken.update({ where: { id }, data: { status: "expired", refreshingUntil: null, lastError: why.slice(0, 300) } });
    if (capability) await tx.partnerConnection.updateMany({ where: { workspaceId, capability, provider, status: "connected" }, data: { status: "error", lastError: `Sign in to ${providerName(provider)} again.` } });
  });
}

/** Sign out of the company: the same as Disconnect (connections.ts), which forgets the tokens with the connection, so the two can never disagree. (Telling the company to revoke the tokens is part of the live adapter, written with it.) */
export async function disconnectOAuth(provider: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: true; changed: boolean }> {
  const capability = capabilityOf(provider);
  if (!capability) return { ok: true, changed: false };
  const out = await disconnectPartner(capability, provider, now, workspaceId);
  return { ok: true, changed: out.ok && out.changed };
}

export type OAuthStatus = { signedIn: boolean; accountId: string | null; status: string | null; accessExpiresAt: Date | null; refreshExpiresAt: Date | null; lastError: string | null; connectedBy: string | null };

/** What a screen may say about a sign-in: never a token. */
export async function oauthStatus(provider: string, workspaceId = currentWorkspaceId()): Promise<OAuthStatus> {
  const row = await prisma.partnerOAuthToken.findUnique({ where: { workspaceId_provider: { workspaceId, provider } }, select: { accountId: true, status: true, accessExpiresAt: true, refreshExpiresAt: true, lastError: true, connectedBy: true } });
  if (!row) return { signedIn: false, accountId: null, status: null, accessExpiresAt: null, refreshExpiresAt: null, lastError: null, connectedBy: null };
  return { signedIn: row.status === "active", ...row };
}
