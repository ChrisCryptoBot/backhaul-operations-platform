import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { sandboxExchanger, type OAuthExchanger } from "@/server/partners/adapters/oauth-exchange";
import { connectPartner, disconnectPartner } from "@/server/partners/connections";
import { advanceCursor, cursorFailed, linkRef, readCursor, refByExternal, refOf, refsOf, unlinkRef } from "@/server/partners/external-refs";
import { accessTokenFor, beginOAuth, completeOAuth, disconnectOAuth, oauthStatus } from "@/server/partners/oauth";

/**
 * Signing in to QuickBooks Online by OAuth, the external-id map and the sync cursors (docs/MONEY_PLAN.md, Wave 3, step 1) on the demo database, in workspaces of their own, through the
 * built-in simulator (a `sandbox_` app client id): no network call.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/accounting-oauth.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "qbo-oauth";
const OTHER = "qbo-other";
const ORIGIN = "http://localhost:3101";
const NOW = new Date("2026-12-01T12:00:00Z");
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_WEBHOOK_SECRET", "DESK_AUTH"];
const saved: Record<string, string | undefined> = {};
const paramsOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** Signs in through the simulator and answers the callback's parameters. */
async function signIn(workspaceId = W, now = NOW) {
  const begun = await beginOAuth("quickbooks", { origin: ORIGIN, who: "Test admin" }, now, workspaceId);
  if (!begun.ok) throw new Error(begun.error);
  return paramsOf(begun.url);
}

describe.skipIf(!run)("signing in to QuickBooks, the external-id map and the cursors", () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    process.env.QUICKBOOKS_CLIENT_ID = "sandbox_qbo_client_1234";
    process.env.QUICKBOOKS_CLIENT_SECRET = "sandbox_qbo_secret_1234";
    for (const id of [W, OTHER]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    }
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const id of [W, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  });

  test("the sign-in starts with a one-time state kept only as its hash, and the simulator comes straight back with a code and a company", async () => {
    const p = await signIn();
    expect(Object.keys(p).sort()).toEqual(["code", "realmId", "state"]);
    expect(p.code).toMatch(/^sandbox_code_/);
    const rows = await prisma.partnerOAuthState.findMany({ where: { workspaceId: W } });
    expect(rows.some((r) => r.stateHash === createHash("sha256").update(p.state!).digest("hex"))).toBe(true);
    expect(rows.some((r) => r.stateHash === p.state)).toBe(false);
  });

  test("the callback trades the code for sealed tokens and makes the connection, once; a played-back, foreign or late state is refused", async () => {
    const p = await signIn();
    const out = await completeOAuth("quickbooks", { state: p.state, code: p.code, accountId: p.realmId }, { origin: ORIGIN, who: "Test admin" }, NOW, W);
    expect(out).toEqual({ ok: true, accountId: "9130350000000000" });
    const tok = await prisma.partnerOAuthToken.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "quickbooks" } } });
    expect([tok.status, tok.accountId, tok.accessExpiresAt.toISOString(), tok.connectedBy]).toEqual(["active", "9130350000000000", "2026-12-01T13:00:00.000Z", "Test admin"]);
    expect(tok.sealed).toMatch(/^v1\./);
    expect(tok.sealed).not.toContain("sandbox_access_");
    const conn = await prisma.partnerConnection.findUniqueOrThrow({ where: { workspaceId_capability_provider: { workspaceId: W, capability: "accounting", provider: "quickbooks" } } });
    expect([conn.status, !!conn.webhookToken]).toEqual(["connected", true]);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_connected", summary: { contains: "signed in" } } })).toBe(1);
    expect((await oauthStatus("quickbooks", W)).signedIn).toBe(true);

    // The same state again.
    expect(await completeOAuth("quickbooks", { state: p.state, code: p.code, accountId: p.realmId }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
    // Started on one desk, finished on another.
    const q = await signIn(OTHER);
    expect(await completeOAuth("quickbooks", { state: q.state, code: q.code, accountId: q.realmId }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("not started from this desk") });
    // Too late (ten minutes), a cancelled sign-in, no company named, a refused code.
    const late = await signIn();
    expect(await completeOAuth("quickbooks", { state: late.state, code: late.code, accountId: late.realmId }, { origin: ORIGIN }, new Date(NOW.getTime() + 11 * 60_000), W)).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
    const cancelled = await signIn();
    expect(await completeOAuth("quickbooks", { state: cancelled.state, error: "access_denied" }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("not completed") });
    const noRealm = await signIn();
    expect(await completeOAuth("quickbooks", { state: noRealm.state, code: noRealm.code, accountId: "../x" }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false });
    const denied = await signIn();
    expect(await completeOAuth("quickbooks", { state: denied.state, code: "sandbox_code_deny", accountId: denied.realmId }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("refused") });
    expect(await completeOAuth("quickbooks", { state: "short", code: "x" }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: false });
    // None of those touched the sign-in that worked.
    expect((await prisma.partnerOAuthToken.findUniqueOrThrow({ where: { id: tok.id } })).sealed).toBe(tok.sealed);
  });

  test("a fresh access token is used as it is; one near its end is refreshed once, even when two calls ask at the same moment", async () => {
    const first = await accessTokenFor("quickbooks", NOW, W);
    expect(first).toMatchObject({ ok: true, accountId: "9130350000000000", accessToken: expect.stringMatching(/^sandbox_access_/) });
    const v0 = (await prisma.partnerOAuthToken.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "quickbooks" } } })).version;
    expect((await accessTokenFor("quickbooks", NOW, W)).ok && v0).toBe(v0);

    let refreshes = 0;
    const slow: OAuthExchanger = { ...sandboxExchanger, refresh: async (a, now) => { refreshes++; await new Promise((r) => setTimeout(r, 300)); return sandboxExchanger.refresh(a, now); } };
    const later = new Date(NOW.getTime() + 58 * 60_000); // two minutes before the hour runs out
    const [a, b] = await Promise.all([accessTokenFor("quickbooks", later, W, { exchanger: slow }), accessTokenFor("quickbooks", later, W, { exchanger: slow })]);
    expect(refreshes).toBe(1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok || !first.ok) return;
    expect(a.accessToken).toBe(b.accessToken);
    expect(a.accessToken).not.toBe(first.accessToken);
    const row = await prisma.partnerOAuthToken.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "quickbooks" } } });
    expect([row.version, row.refreshingUntil, row.accessExpiresAt.toISOString()]).toEqual([v0 + 1, null, "2026-12-01T13:58:00.000Z"]);
  });

  test("a refresh the company refuses for good expires the sign-in and puts the connection in error", async () => {
    const row = await prisma.partnerOAuthToken.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "quickbooks" } } });
    const refusing: OAuthExchanger = { ...sandboxExchanger, refresh: async () => ({ ok: false, code: "upstream_error", message: "invalid_grant", revoked: true }) };
    const later = new Date(row.accessExpiresAt.getTime() + 60_000);
    expect(await accessTokenFor("quickbooks", later, W, { exchanger: refusing })).toMatchObject({ ok: false, code: "expired" });
    expect(await accessTokenFor("quickbooks", later, W)).toMatchObject({ ok: false, code: "expired" });
    expect((await prisma.partnerConnection.findUniqueOrThrow({ where: { workspaceId_capability_provider: { workspaceId: W, capability: "accounting", provider: "quickbooks" } } })).status).toBe("error");
    // Signing in again puts it right.
    const p = await signIn(W, later);
    expect(await completeOAuth("quickbooks", { state: p.state, code: p.code, accountId: p.realmId }, { origin: ORIGIN }, later, W)).toMatchObject({ ok: true });
    expect(await accessTokenFor("quickbooks", later, W)).toMatchObject({ ok: true });
  });

  test("QuickBooks is never connected by the key form, a real app key is not called (no live sign-in yet), and signing out forgets the tokens", async () => {
    expect(await connectPartner("accounting", "quickbooks", null, NOW, OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("signing in") });
    process.env.QUICKBOOKS_CLIENT_ID = "ABcdEF1234567890live";
    expect(await beginOAuth("quickbooks", { origin: ORIGIN }, NOW, OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("not connected to TrueLane yet") });
    process.env.QUICKBOOKS_CLIENT_ID = "sandbox_qbo_client_1234";
    process.env.DESK_AUTH = "on";
    expect(await beginOAuth("quickbooks", { origin: ORIGIN }, NOW, OTHER)).toMatchObject({ ok: false, error: expect.stringContaining("sandbox_") });
    delete process.env.DESK_AUTH;
    expect(await beginOAuth("motive", { origin: ORIGIN }, NOW, OTHER)).toMatchObject({ ok: false });

    // The plain Disconnect (connections.ts) takes the tokens with it: a disconnected company is never called with a token left behind.
    expect(await prisma.partnerOAuthToken.count({ where: { workspaceId: W } })).toBe(1);
    expect(await disconnectPartner("accounting", "quickbooks", NOW, W)).toEqual({ ok: true, changed: true });
    expect(await prisma.partnerOAuthToken.count({ where: { workspaceId: W } })).toBe(0);
    expect((await prisma.partnerConnection.findUniqueOrThrow({ where: { workspaceId_capability_provider: { workspaceId: W, capability: "accounting", provider: "quickbooks" } } })).status).toBe("revoked");
    expect(await accessTokenFor("quickbooks", NOW, W)).toMatchObject({ ok: false, code: "not_connected" });
    expect(await disconnectOAuth("quickbooks", NOW, W)).toEqual({ ok: true, changed: false });
  });

  test("the external-id map links one to one, records each push, and refuses a second link on either side", async () => {
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-1", externalId: "58", syncToken: "0", pushedHash: "h1" }, NOW, W)).toEqual({ ok: true, created: true });
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-1", externalId: "58", syncToken: "1", pushedHash: "h2" }, NOW, W)).toEqual({ ok: true, created: false });
    expect(await refOf("quickbooks", "customer", "cust-1", W)).toMatchObject({ externalId: "58", syncToken: "1", pushedHash: "h2" });
    expect(await refByExternal("quickbooks", "customer", "58", W)).toMatchObject({ localId: "cust-1" });
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-1", externalId: "59" }, NOW, W)).toMatchObject({ ok: false, conflict: "local", error: expect.stringContaining("58") });
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-2", externalId: "58" }, NOW, W)).toMatchObject({ ok: false, conflict: "external" });
    // The same ids in another kind of record, or another desk, are separate.
    expect(await linkRef({ provider: "quickbooks", entity: "invoice", localId: "cust-1", externalId: "58" }, NOW, W)).toMatchObject({ ok: true, created: true });
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-2", externalId: "58" }, NOW, OTHER)).toMatchObject({ ok: true, created: true });
    expect([...(await refsOf("quickbooks", "customer", ["cust-1", "cust-9"], W)).keys()]).toEqual(["cust-1"]);
    expect(await unlinkRef("quickbooks", "customer", "cust-1", W)).toBe(true);
    expect(await linkRef({ provider: "quickbooks", entity: "customer", localId: "cust-2", externalId: "58" }, NOW, W)).toMatchObject({ ok: true, created: true });
  });

  test("a cursor moves only forward from where it was read, and a failed pull leaves it where it was", async () => {
    expect(await readCursor("quickbooks", "payments", W)).toMatchObject({ cursor: null });
    expect(await advanceCursor("quickbooks", "payments", null, "2026-12-01T12:00:00Z", NOW, W)).toBe(true);
    expect(await advanceCursor("quickbooks", "payments", null, "2026-12-01T12:05:00Z", NOW, W)).toBe(false);
    expect(await advanceCursor("quickbooks", "payments", "2026-12-01T11:00:00Z", "2026-12-01T12:05:00Z", NOW, W)).toBe(false);
    expect(await advanceCursor("quickbooks", "payments", "2026-12-01T12:00:00Z", "2026-12-01T12:05:00Z", NOW, W)).toBe(true);
    await cursorFailed("quickbooks", "payments", "QuickBooks did not answer", NOW, W);
    expect(await readCursor("quickbooks", "payments", W)).toMatchObject({ cursor: "2026-12-01T12:05:00Z", lastError: "QuickBooks did not answer" });
    // A stream whose first run failed before it read anything still starts from null.
    await cursorFailed("quickbooks", "customers", "down", NOW, W);
    expect(await advanceCursor("quickbooks", "customers", null, "2026-12-01T12:00:00Z", NOW, W)).toBe(true);
  });
});
