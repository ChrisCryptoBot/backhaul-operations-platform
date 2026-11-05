import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_KEY_ENV, PREVIOUS_KEY_ENV, checkCredential, credentialKey, credentialKeys, hintOf, newWebhookToken, seal, unseal, unsealWithKeys } from "@/server/partners/credentials-core";
import { POLLED, SYNC_POLICY, isOverdue, rhythmOf } from "@/server/partners/sync-policy";
import { CAPABILITIES } from "@/truelane/partners/contract";
import { MAX_WEBHOOK_BYTES, factoringStatusOf, readNeutralEvent, signatureHeaderFor, verifySignature } from "@/server/partners/webhook-core";
import { FAILURES_BEFORE_ERROR, retryMinutes } from "@/server/partners/health";
import { SYNC_EVERY_MINUTES } from "@/server/partners/sync";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const KEY = randomBytes(32);

describe("a fleet's keys are sealed before they are stored", () => {
  it("opens with the same key and with no other, and never shows the value in what is stored", () => {
    const sealed = seal({ MOTIVE_API_KEY: "mk_live_abcdefghijkl" }, KEY);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("mk_live");
    expect(unseal(sealed, KEY)).toEqual({ MOTIVE_API_KEY: "mk_live_abcdefghijkl" });
    expect(unseal(sealed, randomBytes(32))).toBeNull();
  });

  it("refuses an envelope that was changed anywhere, or is not one", () => {
    const sealed = seal({ A_KEY: "x".repeat(20) }, KEY);
    const [v, n, t, c] = sealed.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [`${v}.${flip(n!)}.${t}.${c}`, `${v}.${n}.${flip(t!)}.${c}`, `${v}.${n}.${t}.${flip(c!)}`, `v2.${n}.${t}.${c}`, "", "v1...", "garbage", `${v}.${n}.${t}`]) expect(unseal(bad, KEY), bad).toBeNull();
  });

  it("uses a fresh nonce every time, so the same keys never seal to the same text", () => {
    const a = seal({ K: "same-value-1234" }, KEY);
    const b = seal({ K: "same-value-1234" }, KEY);
    expect(a).not.toBe(b);
  });

  it("takes only a real 32-byte key from the environment", () => {
    expect(credentialKey({})).toBeNull();
    expect(credentialKey({ [CREDENTIAL_KEY_ENV]: "short" })).toBeNull();
    expect(credentialKey({ [CREDENTIAL_KEY_ENV]: randomBytes(16).toString("base64") })).toBeNull();
    expect(credentialKey({ [CREDENTIAL_KEY_ENV]: KEY.toString("base64") })?.equals(KEY)).toBe(true);
    expect(credentialKey({ [CREDENTIAL_KEY_ENV]: KEY.toString("base64url") })?.equals(KEY)).toBe(true);
  });

  it("shows only the last four characters, and nothing of a short value", () => {
    expect(hintOf("sk_live_abcdef123456")).toBe("…3456");
    expect(hintOf("short")).toBe("set");
  });

  it("accepts only the company's own key names, one line each, 8 to 400 characters, and a blank means keep what is there", () => {
    const allowed = ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "GUSTO_WEBHOOK_SECRET"];
    expect(checkCredential({ GUSTO_CLIENT_ID: "  id-12345678  ", GUSTO_CLIENT_SECRET: "" }, allowed)).toEqual({ ok: true, values: { GUSTO_CLIENT_ID: "id-12345678" } });
    expect(checkCredential({ OTHER_KEY: "abcdefghij" }, allowed)).toMatchObject({ ok: false });
    expect(checkCredential({ GUSTO_CLIENT_ID: "short" }, allowed)).toMatchObject({ ok: false });
    expect(checkCredential({ GUSTO_CLIENT_ID: "a".repeat(401) }, allowed)).toMatchObject({ ok: false });
    expect(checkCredential({ GUSTO_CLIENT_ID: "line\nbreak-12345" }, allowed)).toMatchObject({ ok: false });
    expect(checkCredential({ GUSTO_CLIENT_ID: "" }, allowed)).toMatchObject({ ok: false, error: "Paste a key to save." });
  });

  it("makes an unguessable webhook token", () => {
    const t = newWebhookToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newWebhookToken()).not.toBe(t);
  });
});

describe("a company's webhook is verified on the raw bytes", () => {
  const SECRET = "whsec_test_secret_value";
  const body = JSON.stringify({ id: "evt_1", type: "factoring.funded", reference: "INV-1" });
  const sig = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw, "utf8").digest("hex");

  it("accepts the right signature, bare or with its prefix, and nothing else", () => {
    expect(verifySignature(body, sig(body), SECRET)).toBe(true);
    expect(verifySignature(body, `sha256=${sig(body)}`, SECRET)).toBe(true);
    expect(verifySignature(body, sig(body).toUpperCase(), SECRET)).toBe(true);
    expect(verifySignature(body, sig(body, "other"), SECRET)).toBe(false);
    expect(verifySignature(body + " ", sig(body), SECRET)).toBe(false); // one byte more
    for (const bad of [null, undefined, "", "abc", "sha256=", "z".repeat(64), sig(body).slice(1)]) expect(verifySignature(body, bad as string, SECRET), String(bad)).toBe(false);
    expect(verifySignature(body, sig(body), "")).toBe(false); // no secret: never accepted
  });

  it("reads the neutral envelope, gives a body with no id one that is stable, and ignores anything else", () => {
    expect(readNeutralEvent(JSON.parse(body), body)).toEqual({ id: "evt_1", kind: "factoring.funded", reference: "INV-1", referenceId: null });
    const noId = JSON.stringify({ type: "ping" });
    const a = readNeutralEvent(JSON.parse(noId), noId)!;
    expect(a.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readNeutralEvent(JSON.parse(noId), noId)!.id).toBe(a.id);
    for (const bad of [null, [], "x", { type: "rm -rf" }, { type: 7 }, {}]) expect(readNeutralEvent(bad, JSON.stringify(bad))).toBeNull();
    expect(factoringStatusOf("factoring.funded")).toBe("funded");
    expect(factoringStatusOf("ping")).toBeNull();
  });

  it("signs under x-signature until a company is chosen, and caps the body", () => {
    expect(signatureHeaderFor("triumphpay")).toBe("x-signature");
    expect(MAX_WEBHOOK_BYTES).toBe(256 * 1024);
  });
});

describe("how a connection is doing", () => {
  it("backs off 5, 15 and 60 minutes and then six hours, and is in error after three failures in a row", () => {
    expect([1, 2, 3, 4, 9].map(retryMinutes)).toEqual([5, 15, 60, 360, 360]);
    expect(FAILURES_BEFORE_ERROR).toBe(3);
  });
  it("reads hours of service every 15 minutes and carrier checks once a day", () => {
    expect(SYNC_EVERY_MINUTES).toEqual({ eld: 15, vetting: 1440 });
  });
});

describe("what must never happen to a key", () => {
  const all = ["credentials-core.ts", "credentials.ts", "health.ts", "webhook-core.ts", "webhook.ts", "sync.ts", "connections.ts"].map((f) => src(`src/server/partners/${f}`)).join("\n");
  it("is never logged", () => {
    expect(all).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
  it("is never returned by a status call: the status reader returns names, set or not, where from, and a hint, never a value", () => {
    const c = src("src/server/partners/credentials.ts");
    const status = c.slice(c.indexOf("export async function credentialStatus"), c.indexOf("export type SaveCredentialResult"));
    expect(status).not.toContain("unseal(");
    expect(status).not.toContain("storedValues(");
    expect(c.slice(c.indexOf("export async function allCredentialStatus"))).not.toContain("unseal(");
  });
  it("is never in an audit line: a save names the fields and nothing more", () => {
    const c = src("src/server/partners/credentials.ts");
    expect(c).toContain("Object.keys(check.values).join");
    expect(c).not.toMatch(/summary: `[^`]*\$\{(merged|check\.values)\[/);
  });
  it("is never kept in the browser: the keys panel uses no draft, no storage and a password box", () => {
    const panel = src("src/components/desk/integrations-panel.tsx");
    expect(panel).not.toMatch(/useDraft|localStorage|sessionStorage|indexedDB/);
    expect(panel).toContain('type="password"');
    expect(panel).toContain('autoComplete="new-password"');
  });
  it("the webhook checks the signature before it reads the body as JSON, and fails closed when no secret is set", () => {
    const w = src("src/server/partners/webhook.ts");
    expect(w.indexOf("verifySignature(")).toBeGreaterThan(-1);
    expect(w.indexOf("verifySignature(")).toBeLessThan(w.indexOf("JSON.parse("));
    expect(w).toContain("!secret || !verifySignature");
  });
});

describe("rotating the server key without losing anyone's keys", () => {
  const OLD = randomBytes(32);
  const NEW = randomBytes(32);

  it("reads the previous key from its own name, and only a real key counts", () => {
    expect(credentialKeys({})).toEqual({ current: null, previous: null });
    const both = credentialKeys({ [CREDENTIAL_KEY_ENV]: NEW.toString("base64"), [PREVIOUS_KEY_ENV]: OLD.toString("base64") });
    expect(both.current!.equals(NEW)).toBe(true);
    expect(both.previous!.equals(OLD)).toBe(true);
    expect(credentialKeys({ [CREDENTIAL_KEY_ENV]: NEW.toString("base64"), [PREVIOUS_KEY_ENV]: "short" }).previous).toBeNull();
  });

  it("opens with the current key first, then the previous, and says which opened it", () => {
    const keys = { current: NEW, previous: OLD };
    expect(unsealWithKeys(seal({ A_KEY: "value-one-12345" }, NEW), keys)).toEqual({ values: { A_KEY: "value-one-12345" }, usedPrevious: false });
    expect(unsealWithKeys(seal({ A_KEY: "value-one-12345" }, OLD), keys)).toEqual({ values: { A_KEY: "value-one-12345" }, usedPrevious: true });
  });

  it("a key that is neither opens nothing, and a rotation with no previous key opens only the current", () => {
    expect(unsealWithKeys(seal({ A_KEY: "value-one-12345" }, randomBytes(32)), { current: NEW, previous: OLD })).toBeNull();
    expect(unsealWithKeys(seal({ A_KEY: "value-one-12345" }, OLD), { current: NEW, previous: null })).toBeNull();
    expect(unsealWithKeys(seal({ A_KEY: "value-one-12345" }, NEW), { current: null, previous: null })).toBeNull();
  });
});

describe("how each kind of partner reaches the desk", () => {
  it("every capability the contract has says how, so none can be added without a rhythm", () => {
    expect(Object.keys(SYNC_POLICY).sort()).toEqual([...CAPABILITIES].sort());
    for (const c of CAPABILITIES) expect(rhythmOf(c), c).not.toBe("");
  });

  it("only the polled kinds are on the schedule, at their own rhythm", () => {
    expect(POLLED).toEqual({ eld: 15, vetting: 1440 });
    expect(SYNC_POLICY.factoring.mode).toBe("events");
    expect(SYNC_POLICY.payroll.mode).toBe("events");
    expect(SYNC_POLICY.tracking.mode).toBe("events");
    expect(SYNC_POLICY.fuel_card.mode).toBe("on_demand");
    expect(SYNC_POLICY.ifta.mode).toBe("on_demand");
  });

  it("a polled connection is overdue only after its allowance with no answer; a told or asked-for kind never is", () => {
    const now = new Date("2026-12-02T12:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    const eld = (over: Partial<{ status: string; lastSyncedAt: Date | null; connectedAt: Date | null }>) => ({ capability: "eld", status: "connected", lastSyncedAt: ago(10), connectedAt: ago(5000), ...over });
    expect(isOverdue(eld({}), now)).toBe(false);
    expect(isOverdue(eld({ lastSyncedAt: ago(91) }), now)).toBe(true);
    expect(isOverdue(eld({ lastSyncedAt: ago(89) }), now)).toBe(false);
    // Never answered: counted from when it was connected.
    expect(isOverdue(eld({ lastSyncedAt: null, connectedAt: ago(200) }), now)).toBe(true);
    expect(isOverdue(eld({ lastSyncedAt: null, connectedAt: ago(20) }), now)).toBe(false);
    // Not live, or never connected: nothing to be overdue about.
    expect(isOverdue(eld({ status: "revoked", lastSyncedAt: ago(9999) }), now)).toBe(false);
    expect(isOverdue(eld({ status: "pending", lastSyncedAt: null, connectedAt: null }), now)).toBe(false);
    expect(isOverdue({ capability: "factoring", status: "connected", lastSyncedAt: ago(99999), connectedAt: ago(99999) }, now)).toBe(false);
    expect(isOverdue({ capability: "fuel_card", status: "error", lastSyncedAt: ago(99999), connectedAt: ago(99999) }, now)).toBe(false);
    // A carrier check is read daily and allowed three.
    expect(isOverdue({ capability: "vetting", status: "connected", lastSyncedAt: ago(3 * 1440 + 1), connectedAt: null }, now)).toBe(true);
    expect(isOverdue({ capability: "vetting", status: "connected", lastSyncedAt: ago(2 * 1440), connectedAt: null }, now)).toBe(false);
  });
});
