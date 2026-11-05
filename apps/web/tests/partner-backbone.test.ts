import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_KEY_ENV, checkCredential, credentialKey, hintOf, newWebhookToken, seal, unseal } from "@/server/partners/credentials-core";
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
