import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, PROVIDERS, WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { FAILURES_BEFORE_ERROR, retryMinutes } from "@/server/partners/health";
import { shippedProviders } from "@/server/partners/adapters";
import { SYNC_POLICY } from "@/server/partners/sync-policy";
import { EVENT_KINDS, MAX_WEBHOOK_BYTES, signatureHeaderFor, verifySignature } from "@/server/partners/webhook-core";
import { API_SCOPES, DEFAULT_LIMIT, MAX_ACTIVE_KEYS, MAX_LIMIT, RATE_LIMIT } from "@/lib/api-keys";
import { FEATURE_PLAN, MONEY_MOVING_ENV, SWITCH_REASON_MIN } from "@/lib/partner-gates";
import { PLAN_KEYS, planOf } from "@/lib/plans";
import { DEAD_BEFORE_DISABLE, DELIVERY_TIMEOUT_MS, HEADER_EVENT_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, MAX_ATTEMPTS, TEST_EVENT, TOLERANCE_SECONDS, WEBHOOK_EVENTS, backoffMinutes, signatureHeader, verifySignatureHeader } from "@/lib/webhook-sign";
import { READERS } from "@/server/api/reads";

const doc = fs.readFileSync(path.join(__dirname, "../../../docs/PARTNER_INTEGRATION_SPEC.md"), "utf8");

/**
 * The partner-facing specification says what the code does. This reads the document and the code and fails when they disagree: every route, header, event kind and number it cites, and the
 * worked signature, which is recomputed here.
 */
describe("the partner integration spec matches the code", () => {
  it("names the routes and headers that exist", () => {
    expect(doc).toContain("POST /partners/webhook/{provider}/{token}");
    expect(doc).toContain("POST /partners/cron");
    expect(doc).toContain("x-partner-cron");
    expect(doc).toContain(`**\`${signatureHeaderFor("motive")}\`**`);
    expect(fs.existsSync(path.join(__dirname, "../src/app/(public)/partners/webhook/[provider]/[token]/route.ts"))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, "../src/app/(public)/partners/cron/route.ts"))).toBe(true);
  });

  it("lists every event kind, and the body limit", () => {
    for (const k of EVENT_KINDS) expect(doc, k).toContain(`\`${k}\``);
    expect(doc).toContain(`${MAX_WEBHOOK_BYTES / 1024} KB`);
  });

  it("states the polling rhythm and the backoff the code uses", () => {
    expect(doc).toContain(`every ${SYNC_POLICY.eld.everyMinutes} minutes`);
    expect(doc).toContain(`no answer for ${SYNC_POLICY.eld.staleAfterMinutes} minutes`);
    expect(doc).toContain(`after **${FAILURES_BEFORE_ERROR}** in a row`);
    expect(doc).toContain(`**${[1, 2, 3].map(retryMinutes).join(", ")} minutes, then ${retryMinutes(4) / 60} hours**`);
  });

  it("the worked signature is the real HMAC, and the verifier accepts it", () => {
    const secret = "whsec_example_0123456789";
    const body = '{"id":"evt_1001","type":"factoring.funded","reference":"INV-1001","reference_id":"TP-77"}';
    const sig = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(doc).toContain(secret);
    expect(doc).toContain(body);
    expect(doc).toContain(`x-signature: ${sig}`);
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(body, `sha256=${sig}`, secret)).toBe(true);
    expect(verifySignature(body + " ", sig, secret)).toBe(false);
  });

  it("names every company in the contract, and is plain that Spireon is not one of them", () => {
    for (const list of Object.values(PROVIDERS)) for (const name of list) expect(doc.toLowerCase(), name).toContain(name === "fourkites" ? "fourkites" : name);
    expect(Object.values(PROVIDERS).flat()).not.toContain("spireon");
    expect(doc).toContain("**Spireon is not a company the contract knows.**");
    for (const secret of Object.values(WEBHOOK_SECRET_ENV).slice(0, 2)) expect(doc).toContain(secret);
  });

  it("claims a simulator only for the companies that have one, and not_implemented for the rest", () => {
    expect(Object.fromEntries((Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).map((c) => [c, shippedProviders(c)]))).toEqual({ factoring: ["triumphpay"], eld: ["motive"], fuel_card: ["wex"], tracking: ["project44"], vetting: ["highway"], payroll: ["gusto"], ifta: ["promiles"], accounting: ["quickbooks"] });
    expect(doc).toContain("Samsara: answers `not_implemented`");
    expect(doc).toContain("FourKites: `not_implemented`");
    expect(doc).toContain("AtoB: `not_implemented`");
  });

  it("names the read API routes, the Bearer header, every scope, the request id and the paging and rate numbers", () => {
    for (const scope of API_SCOPES) {
      expect(doc, scope).toContain(`\`GET /api/v1/${scope}\``);
      expect(doc, scope).toContain(`\`${scope}\``);
      expect(fs.existsSync(path.join(__dirname, `../src/app/(public)/api/v1/${scope}/route.ts`)), scope).toBe(true);
    }
    expect(Object.keys(READERS).sort()).toEqual([...API_SCOPES].sort());
    expect(doc).toContain("`Authorization: Bearer <key>`");
    expect(doc).toContain("**`x-request-id`**");
    expect(doc).toContain("`x-ratelimit-limit`");
    expect(doc).toContain(`**${RATE_LIMIT} requests a minute per key**`);
    expect(doc).toContain(`\`limit\` is ${DEFAULT_LIMIT} when not given and is held to 1..${MAX_LIMIT}`);
    expect(doc).toContain(`at most ${MAX_ACTIVE_KEYS} keys in use`);
    for (const code of ["unauthenticated", "revoked", "forbidden_scope", "plan", "rate_limited", "bad_request", "server_error"]) expect(doc, code).toContain(`\`${code}\``);
  });

  it("names the outbound headers, every outbound event, the window and the retry numbers", () => {
    for (const h of [HEADER_EVENT_ID, HEADER_TIMESTAMP, HEADER_SIGNATURE]) expect(doc, h).toContain(`**\`${h}\`**`);
    for (const e of WEBHOOK_EVENTS) expect(doc, e).toContain(`\`${e}\``);
    expect(doc).toContain(`\`${TEST_EVENT}\``);
    expect(doc).toContain(`more than **${TOLERANCE_SECONDS / 60} minutes** from your own clock`);
    expect(doc).toContain(`retried after **${[1, 2, 3].map(backoffMinutes).join(", ")} minutes, then every ${backoffMinutes(4) / 60} hours**`);
    expect(doc).toContain(`the **${MAX_ATTEMPTS}th** failed attempt makes it \`dead\``);
    expect(doc).toContain(`**${DEAD_BEFORE_DISABLE}** dead deliveries in a row switch the endpoint off`);
    expect(doc).toContain(`no answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds`);
    expect(doc).toContain("`169.254.169.254`");
  });

  it("the Settings webhook card says how long retries last, as the schedule has it", () => {
    const card = fs.readFileSync(path.join(__dirname, "../src/components/desk/webhooks-card.tsx"), "utf8");
    let minutes = 0;
    for (let failed = 1; failed < MAX_ATTEMPTS; failed++) minutes += backoffMinutes(failed);
    expect(card).toContain(`tried again for about ${Math.floor(minutes / 60)} hours (${MAX_ATTEMPTS} tries in all)`);
  });

  it("the worked outbound signature is what the desk sends, and the real verifier accepts it only inside the window", () => {
    const secret = "whsec_example_secret";
    const t = 1767225600;
    const body = '{"id":"evt_0123456789abcdef0123456789abcdef","object":"event","type":"invoice.created"}';
    const header = signatureHeader(secret, t, body);
    expect(header).toMatch(/^t=1767225600,v1=[0-9a-f]{64}$/);
    expect(doc).toContain(`secret \`${secret}\`, timestamp \`${t}\``);
    expect(doc).toContain(body);
    expect(doc).toContain(`x-truelane-signature: ${header}`);
    expect(verifySignatureHeader(header, secret, body, t)).toBe(true);
    expect(verifySignatureHeader(header, secret, body, t + TOLERANCE_SECONDS)).toBe(true);
    expect(verifySignatureHeader(header, secret, body, t + TOLERANCE_SECONDS + 1)).toBe(false);
    expect(verifySignatureHeader(header, secret, body + " ", t)).toBe(false);
  });

  it("states the plan line and the money-moving switch as the code has them", () => {
    expect(FEATURE_PLAN.read_api).toBe(FEATURE_PLAN.outbound_webhooks);
    expect(doc).toContain(`**the read API and outbound webhooks come with the ${planOf(FEATURE_PLAN.read_api).label} plan and up**`);
    for (const c of CAPABILITIES) expect(FEATURE_PLAN[c], c).toBe(PLAN_KEYS[0]);
    expect(doc).toContain("every company capability in section 1 is on every plan");
    expect(doc).toContain(`**\`${MONEY_MOVING_ENV}\`**\`=yes\``);
    expect(doc).toContain(`at least ${SWITCH_REASON_MIN} characters`);
  });

  it("does not claim more than is built: no live company, and no telematics push event", () => {
    expect(doc).toContain("The live call to a company is not switched on");
    expect(doc).toContain("There is no telematics push event");
    expect(doc).not.toMatch(/100%|fully integrated|production[- ]ready/i);
  });
});
