import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { FAILURES_BEFORE_ERROR, retryMinutes } from "@/server/partners/health";
import { shippedProviders } from "@/server/partners/adapters";
import { SYNC_POLICY } from "@/server/partners/sync-policy";
import { EVENT_KINDS, MAX_WEBHOOK_BYTES, signatureHeaderFor, verifySignature } from "@/server/partners/webhook-core";

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
    expect(Object.fromEntries((Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).map((c) => [c, shippedProviders(c)]))).toEqual({ factoring: ["triumphpay"], eld: ["motive"], fuel_card: ["wex"], tracking: ["project44"], vetting: ["highway"], payroll: ["gusto"], ifta: ["promiles"] });
    expect(doc).toContain("Samsara: answers `not_implemented`");
    expect(doc).toContain("FourKites: `not_implemented`");
    expect(doc).toContain("AtoB: `not_implemented`");
  });

  it("does not claim more than is built: no live company, and no telematics push event", () => {
    expect(doc).toContain("The live call to a company is not switched on");
    expect(doc).toContain("There is no telematics push event");
    expect(doc).not.toMatch(/100%|fully integrated|production[- ]ready/i);
  });
});
