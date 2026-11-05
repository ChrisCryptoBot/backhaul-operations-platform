import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { callPartner, partnerAdapters, partnerState } from "@/server/partners/call";
import { connectPartner, disconnectPartner, partnerStatus, retryConnection, webhookPath } from "@/server/partners/connections";
import { allCredentialStatus, credentialStatus, deleteCredential, saveCredential, workspaceReader } from "@/server/partners/credentials";
import { handleWebhook } from "@/server/partners/webhook";
import { runPartnerSync } from "@/server/partners/sync";

/**
 * The partner backbone on the demo database, in a workspace of its own, with the company's adapter stood in by a test double (no company is chosen):
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/partner-backbone.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "pb-backbone";
const OTHER = "pb-other";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "MOTIVE_API_KEY", "SAMSARA_API_KEY", "TRIUMPHPAY_API_KEY", "TRIUMPHPAY_WEBHOOK_SECRET"];
const originals = { ...partnerAdapters };
const saved: Record<string, string | undefined> = {};
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw, "utf8").digest("hex");

describe.skipIf(!run)("the partner backbone", () => {
  let loadId = "";
  let token = "";
  const WH_SECRET = "whsec_pb_test_signing_secret";

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    for (const id of [W, OTHER]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    }
    const stops = { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: days(-5), timeWindowLatest: days(-5) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", timeWindowEarliest: days(-4), timeWindowLatest: days(-4) }] };
    loadId = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "PB-L1", status: "completed", completedAt: days(-3), quotedRevenue: 1500, paymentStatus: "invoiced", invoiceNumber: "PB-INV-1", invoicedAt: days(-2), invoicedAmount: 1500, factoringStatus: "requested", stops } })).id;
  });

  afterAll(async () => {
    Object.assign(partnerAdapters, originals);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
  });

  test("a fleet's own keys are sealed, shown only as hints, read by name, kept apart per fleet, and beat the server's", async () => {
    expect(await partnerState("eld", "motive", W)).toMatchObject({ configured: false });
    expect(await saveCredential("motive", { MOTIVE_API_KEY: "short" }, new Date(), W)).toMatchObject({ ok: false });
    expect(await saveCredential("nobody", { X: "abcdefghij" }, new Date(), W)).toMatchObject({ ok: false });
    expect(await saveCredential("motive", { MOTIVE_API_KEY: "fleet-motive-key-0001" }, new Date(), W)).toEqual({ ok: true, changed: ["MOTIVE_API_KEY"] });

    const row = await prisma.partnerCredential.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "motive" } } });
    expect(row.sealed).not.toContain("fleet-motive-key");
    expect(JSON.stringify(row.hints)).not.toContain("fleet-motive-key");
    expect(row.hints).toEqual({ MOTIVE_API_KEY: "…0001" });

    const status = await credentialStatus("motive", W);
    expect(JSON.stringify(status)).not.toContain("fleet-motive-key");
    expect(status.find((f) => f.name === "MOTIVE_API_KEY")).toEqual({ name: "MOTIVE_API_KEY", set: true, hint: "…0001", from: "fleet" });
    expect(JSON.stringify([...(await allCredentialStatus(W)).entries()])).not.toContain("fleet-motive-key");

    expect(await partnerState("eld", "motive", W)).toMatchObject({ configured: true, connected: false });
    expect(await partnerState("eld", "motive", OTHER)).toMatchObject({ configured: false }); // another fleet does not see it
    expect((await workspaceReader("motive", W))("MOTIVE_API_KEY")).toBe("fleet-motive-key-0001");
    process.env.MOTIVE_API_KEY = "server-wide-key-9999";
    expect((await workspaceReader("motive", W))("MOTIVE_API_KEY")).toBe("fleet-motive-key-0001"); // the fleet's own first
    expect((await workspaceReader("motive", OTHER))("MOTIVE_API_KEY")).toBe("server-wide-key-9999"); // else the server's
    expect((await credentialStatus("motive", OTHER)).find((f) => f.name === "MOTIVE_API_KEY")).toMatchObject({ set: true, from: "server", hint: null });
    delete process.env.MOTIVE_API_KEY;

    const events = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "partner_credentials_saved" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("Keys saved for motive: MOTIVE_API_KEY");
  });

  test("a tampered or unreadable row is no credential, never a wrong one", async () => {
    const row = await prisma.partnerCredential.findUniqueOrThrow({ where: { workspaceId_provider: { workspaceId: W, provider: "motive" } } });
    await prisma.partnerCredential.update({ where: { id: row.id }, data: { sealed: row.sealed.slice(0, -3) + "AAA" } });
    expect((await workspaceReader("motive", W))("MOTIVE_API_KEY")).toBeUndefined();
    expect(await partnerState("eld", "motive", W)).toMatchObject({ configured: false });
    await prisma.partnerCredential.update({ where: { id: row.id }, data: { sealed: row.sealed } });
    expect((await workspaceReader("motive", W))("MOTIVE_API_KEY")).toBe("fleet-motive-key-0001");
  });

  test("connecting needs keys, then writes a webhook address once; the status says so without any secret", async () => {
    expect(await connectPartner("eld", "samsara", null, new Date(), W)).toMatchObject({ ok: false });
    expect(await connectPartner("eld", "motive", "Main", new Date(), W)).toEqual({ ok: true, changed: true });
    const rows = await partnerStatus(W);
    const r = rows.find((x) => x.provider === "motive")!;
    expect(r).toMatchObject({ configured: true, connected: true, status: "connected", failures: 0, lastError: null });
    expect(JSON.stringify(rows)).not.toMatch(/fleet-motive|webhook|token/i);
    const path = (await webhookPath("eld", "motive", W))!;
    expect(path).toMatch(/^\/partners\/webhook\/motive\/[A-Za-z0-9_-]{32}$/);
    await connectPartner("eld", "motive", "Main", new Date(), W);
    expect(await webhookPath("eld", "motive", W)).toBe(path); // the same address, not a new one each time
    expect(await disconnectPartner("eld", "motive", new Date(), W)).toEqual({ ok: true, changed: true });
    expect(await webhookPath("eld", "motive", W)).toBeNull();
  });

  test("calls that fail are counted and shown: three in a row is an error with a reason, and a success clears it", async () => {
    await connectPartner("eld", "motive", null, new Date(), W);
    (partnerAdapters as Record<string, unknown>).eld = async () => {
      throw new Error("the company said: secret detail that must not be kept");
    };
    for (let i = 1; i <= 3; i++) {
      const out = await callPartner("eld", "motive", { vehicles: [] }, W);
      expect(out.result).toMatchObject({ ok: false, code: "upstream_error" });
      const c = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, provider: "motive" } });
      expect(c.failures).toBe(i);
      expect(c.lastError).toBe("upstream_error");
      expect(c.status).toBe(i >= 3 ? "error" : "connected");
      expect(c.nextSyncAt!.getTime()).toBeGreaterThan(Date.now());
    }
    expect((await partnerStatus(W)).find((x) => x.provider === "motive")).toMatchObject({ status: "error", connected: false, failures: 3, lastError: "upstream_error" });
    expect(JSON.stringify(await prisma.partnerConnection.findMany({ where: { workspaceId: W } }))).not.toContain("secret detail");

    // Not being live yet is not a failure.
    (partnerAdapters as Record<string, unknown>).eld = originals.eld;
    await retryConnection("eld", "motive", new Date(), W);
    await callPartner("eld", "motive", { vehicles: [] }, W);
    expect(await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, provider: "motive" } })).toMatchObject({ failures: 0, status: "connected" });

    (partnerAdapters as Record<string, unknown>).eld = async () => ({ ok: true, data: { vehicles: [] } });
    await callPartner("eld", "motive", { vehicles: [] }, W);
    const ok = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, provider: "motive" } });
    expect(ok).toMatchObject({ failures: 0, lastError: null, status: "connected" });
    expect(ok.lastSyncedAt).not.toBeNull();
  });

  test("the schedule runs what is due at its own rhythm, backs off a failure, and never hammers a company that is not live", async () => {
    const where = { workspaceId: W, provider: "motive" };
    const now = new Date();
    await prisma.partnerConnection.updateMany({ where, data: { nextSyncAt: new Date(now.getTime() - 1000), failures: 0, status: "connected" } });
    (partnerAdapters as Record<string, unknown>).eld = async () => ({ ok: true, data: { vehicles: [] } });
    expect(await runPartnerSync({ now, workspaceId: W })).toMatchObject({ ran: 1, ok: 1, failed: 0 });
    const next = (await prisma.partnerConnection.findFirstOrThrow({ where })).nextSyncAt!;
    expect(next.getTime() - now.getTime()).toBe(15 * 60_000);
    expect(await runPartnerSync({ now, workspaceId: W })).toMatchObject({ ran: 0 }); // not due again yet

    await prisma.partnerConnection.updateMany({ where, data: { nextSyncAt: new Date(now.getTime() - 1000) } });
    (partnerAdapters as Record<string, unknown>).eld = async () => {
      throw new Error("down");
    };
    expect(await runPartnerSync({ now, workspaceId: W })).toMatchObject({ ran: 1, failed: 1 });
    const failed = await prisma.partnerConnection.findFirstOrThrow({ where });
    expect(failed.failures).toBe(1);
    // The first backoff (5 minutes, counted from the failure itself, which reads the real clock), not the normal 15.
    const wait = failed.nextSyncAt!.getTime() - now.getTime();
    expect(wait).toBeGreaterThanOrEqual(5 * 60_000);
    expect(wait).toBeLessThan(5 * 60_000 + 10_000);

    await prisma.partnerConnection.updateMany({ where, data: { nextSyncAt: new Date(now.getTime() - 1000), failures: 0 } });
    (partnerAdapters as Record<string, unknown>).eld = originals.eld; // the stub: "not implemented"
    expect(await runPartnerSync({ now, workspaceId: W })).toMatchObject({ ran: 1, waiting: 1, failed: 0 });
    expect((await prisma.partnerConnection.findFirstOrThrow({ where })).failures).toBe(0);
  });

  describe("a company's webhook", () => {
    const send = (type: string, id: string, extra: Record<string, unknown> = {}, secret = WH_SECRET, tok = () => token) => {
      const raw = JSON.stringify({ id, type, reference: "PB-INV-1", ...extra });
      return handleWebhook({ provider: "triumphpay", token: tok(), raw, signature: sign(raw, secret) });
    };

    beforeAll(async () => {
      await saveCredential("triumphpay", { TRIUMPHPAY_API_KEY: "fleet-factor-key-0002", TRIUMPHPAY_WEBHOOK_SECRET: WH_SECRET }, new Date(), W);
      expect(await connectPartner("factoring", "triumphpay", null, new Date(), W)).toMatchObject({ ok: true });
      token = (await webhookPath("factoring", "triumphpay", W))!.split("/").pop()!;
    });

    test("an unknown address is nothing, a wrong or missing signature is refused with no detail, and nothing is recorded", async () => {
      const raw = JSON.stringify({ id: "e0", type: "factoring.funded", reference: "PB-INV-1" });
      expect((await handleWebhook({ provider: "triumphpay", token: "x".repeat(32), raw, signature: sign(raw, WH_SECRET) })).status).toBe(404);
      expect((await handleWebhook({ provider: "motive", token, raw, signature: sign(raw, WH_SECRET) })).status).toBe(404); // the wrong company for this address
      expect((await handleWebhook({ provider: "triumphpay", token, raw, signature: sign(raw, "someone else's secret") })).status).toBe(401);
      expect((await handleWebhook({ provider: "triumphpay", token, raw, signature: null })).status).toBe(401);
      expect((await handleWebhook({ provider: "triumphpay", token, raw: raw + " ", signature: sign(raw, WH_SECRET) })).status).toBe(401); // altered in flight
      expect((await handleWebhook({ provider: "triumphpay", token, raw: "x".repeat(300 * 1024), signature: "a" })).status).toBe(413);
      expect(await prisma.partnerEvent.count({ where: { workspaceId: W } })).toBe(0);
      expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("requested");
    });

    test("with no signing secret set at all, nothing is accepted", async () => {
      await prisma.partnerCredential.update({ where: { workspaceId_provider: { workspaceId: W, provider: "triumphpay" } }, data: { sealed: "v1.a.b.c" } });
      expect((await send("factoring.funded", "e-nosecret")).status).toBe(401);
      await saveCredential("triumphpay", { TRIUMPHPAY_API_KEY: "fleet-factor-key-0002", TRIUMPHPAY_WEBHOOK_SECRET: WH_SECRET }, new Date(), W);
      expect((await send("ping", "e-back")).body).toMatchObject({ ok: true });
    });

    test("an event moves the invoice one allowed step, once: a repeat is a duplicate, and an out-of-order event does nothing", async () => {
      expect((await send("factoring.submitted", "e1", { reference_id: "FACT-77" })).body).toEqual({ ok: true, result: "applied" });
      expect(await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).toMatchObject({ factoringStatus: "submitted", factoringReferenceId: "FACT-77" });
      expect((await send("factoring.submitted", "e1")).body).toEqual({ ok: true, result: "duplicate" });
      expect((await send("factoring.funded", "e2")).body).toEqual({ ok: true, result: "applied" });
      expect((await send("factoring.rejected", "e3")).body).toEqual({ ok: true, result: "ignored" }); // funded cannot become rejected
      expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("funded");
      expect((await send("factoring.paid", "e4")).body).toEqual({ ok: true, result: "applied" });
      expect((await send("factoring.funded", "e5")).body).toEqual({ ok: true, result: "ignored" }); // backwards, late
      expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("paid");
      const audits = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "factoring_updated" } });
      expect(audits).toHaveLength(3);
    });

    test("the same event delivered twice at the same moment is one event", async () => {
      const raw = JSON.stringify({ id: "e-race", type: "ping" });
      const sig = sign(raw, WH_SECRET);
      const [a, b] = await Promise.all([handleWebhook({ provider: "triumphpay", token, raw, signature: sig }), handleWebhook({ provider: "triumphpay", token, raw, signature: sig })]);
      expect([a.body.result, b.body.result].sort()).toEqual(["applied", "duplicate"]);
    });

    test("an event it cannot place is recorded as ignored with a reason, no body kept; a bad body with a good signature is a 400", async () => {
      expect((await send("factoring.funded", "e-lost", { reference: "NO-SUCH-INVOICE" })).body).toEqual({ ok: true, result: "ignored" });
      const lost = await prisma.partnerEvent.findFirstOrThrow({ where: { workspaceId: W, eventId: `${W}:e-lost` } });
      expect(lost).toMatchObject({ outcome: "ignored", detail: "No invoice with that reference." });
      expect(JSON.stringify(lost)).not.toContain("NO-SUCH-INVOICE");
      const raw = "{not json";
      expect((await handleWebhook({ provider: "triumphpay", token, raw, signature: sign(raw, WH_SECRET) })).status).toBe(400);
      const odd = JSON.stringify({ id: "e-odd", type: "something.else" });
      expect((await handleWebhook({ provider: "triumphpay", token, raw: odd, signature: sign(odd, WH_SECRET) })).body).toEqual({ ok: true, result: "ignored" });
    });

    test("an event for one fleet never touches another's invoice with the same number", async () => {
      await prisma.load.create({ data: { workspaceId: OTHER, loadNumber: "PB-X1", status: "completed", completedAt: days(-3), quotedRevenue: 800, paymentStatus: "invoiced", invoiceNumber: "PB-INV-1", invoicedAt: days(-2), invoicedAmount: 800, factoringStatus: "requested" } });
      await prisma.load.update({ where: { id: loadId }, data: { factoringStatus: "requested", paymentStatus: "invoiced" } });
      await send("factoring.submitted", "e-iso");
      expect((await prisma.load.findFirstOrThrow({ where: { workspaceId: OTHER, loadNumber: "PB-X1" } })).factoringStatus).toBe("requested");
      expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("submitted");
    });

    test("removing a fleet's keys forgets them", async () => {
      expect(await deleteCredential("triumphpay", new Date(), W)).toBe(true);
      expect(await deleteCredential("triumphpay", new Date(), W)).toBe(false);
      expect((await send("ping", "e-after")).status).toBe(401);
    });
  });
});
