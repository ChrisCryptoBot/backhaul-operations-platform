import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_ATTEMPTS, WEBHOOK_EVENTS, backoffMinutes, cleanEndpointInput } from "@/lib/webhook-events";
import { HEADER_EVENT_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, signatureHeader, signatureOf, verifySignatureHeader } from "@/lib/webhook-sign";
import { checkAddresses, checkUrl, isBlockedIp, parseIpv6 } from "@/lib/webhook-target";
import { pinnedLookup, pinnedTransport } from "@/server/webhooks/transport";

/** Money plan Wave 7 step 3, pure and local: where a webhook may go, the signature, the retry rhythm, the pinned connection, and that every money write path queues its event. */
const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

describe("where a webhook may go", () => {
  test("public addresses pass; every private, local, reserved and metadata range is refused, in IPv4 and IPv6", () => {
    for (const ok of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1"]) expect(isBlockedIp(ok), ok).toBe(false);
    for (const bad of [
      "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200", "127.0.0.1", "127.1.2.3", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1",
      "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::", "2002:a9fe:a9fe::1", "fc00::1", "fd00:ec2::254", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "not an address", "1.2.3", "01.2.3.4", "fe80::1%eth0"
    ])
      expect(isBlockedIp(bad), bad).toBe(true);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("2002:0808:0808::1")).toBe(false);
  });

  test("IPv6 text is read the same however it is written", () => {
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("::ffff:7f00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1::8")).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
    for (const bad of ["1:2:3:4:5:6:7:8:9", "1::2::3", "12345::", "g::1", "1:2:3:4:5:6:7"]) expect(parseIpv6(bad), bad).toBeNull();
  });

  test("the address: https in production, no credentials, no local names, and an IP written in it is judged at once (however it is spelled)", () => {
    expect(checkUrl("https://hooks.example.com/truelane?x=1", { production: true })).toMatchObject({ ok: true, host: "hooks.example.com", literal: null });
    expect(checkUrl("http://hooks.example.com/", { production: true })).toMatchObject({ ok: false });
    expect(checkUrl("http://hooks.example.com/", { production: false })).toMatchObject({ ok: true });
    for (const bad of ["https://user:pass@hooks.example.com/", "https://user@hooks.example.com/", "ftp://hooks.example.com/", "javascript:alert(1)", "file:///etc/passwd", "not a url", "", "https://localhost/x", "https://a.localhost/", "https://printer.local/", "https://metadata.google.internal/"])
      expect(checkUrl(bad, { production: false }), bad).toMatchObject({ ok: false });
    for (const bad of ["https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:169.254.169.254]/", "https://10.1.2.3:8443/", "https://[fd00:ec2::254]/"])
      expect(checkUrl(bad, { production: true }), bad).toMatchObject({ ok: false, error: expect.stringContaining("private network") });
    expect(checkUrl("https://93.184.216.34/hook", { production: true })).toMatchObject({ ok: true, literal: "93.184.216.34" });
    expect(checkUrl(`https://h.example.com/${"x".repeat(600)}`, { production: true })).toMatchObject({ ok: false });
  });

  test("every answer a name resolves to must be public: one private answer refuses the lot", () => {
    expect(checkAddresses([{ address: "93.184.216.34", family: 4 }])).toEqual({ ok: true, address: "93.184.216.34", family: 4 });
    expect(checkAddresses([{ address: "2606:4700::1111", family: 6 }])).toEqual({ ok: true, address: "2606:4700::1111", family: 6 });
    expect(checkAddresses([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])).toMatchObject({ ok: false });
    expect(checkAddresses([{ address: "::ffff:127.0.0.1", family: 6 }])).toMatchObject({ ok: false });
    expect(checkAddresses([])).toMatchObject({ ok: false });
  });
});

describe("the signature", () => {
  // The worked example in docs/PARTNER_INTEGRATION_SPEC.md (Wave 7 step 6) uses these same three values.
  const secret = "whsec_example_secret";
  const t = 1767225600;
  const body = '{"id":"evt_0123456789abcdef0123456789abcdef","object":"event","type":"invoice.created"}';

  test("t=<timestamp>,v1=<hex HMAC-SHA256 of '<timestamp>.<raw body>'>", () => {
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(signatureOf(secret, t, body)).toBe(v1);
    expect(signatureHeader(secret, t, body)).toBe(`t=${t},v1=${v1}`);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect([HEADER_EVENT_ID, HEADER_TIMESTAMP, HEADER_SIGNATURE]).toEqual(["x-truelane-event-id", "x-truelane-timestamp", "x-truelane-signature"]);
  });

  test("a receiver accepts it within five minutes and refuses a changed body, another secret, an old or future timestamp, or a mangled header", () => {
    const h = signatureHeader(secret, t, body);
    expect(verifySignatureHeader(h, secret, body, t + 299)).toBe(true);
    expect(verifySignatureHeader(h, secret, body, t - 299)).toBe(true);
    expect(verifySignatureHeader(h, secret, body, t + 301)).toBe(false);
    expect(verifySignatureHeader(h, secret, body, t - 301)).toBe(false);
    expect(verifySignatureHeader(h, secret, body.replace("invoice", "payment"), t)).toBe(false);
    expect(verifySignatureHeader(h, "whsec_other", body, t)).toBe(false);
    for (const bad of [null, "", "v1=abc", `t=${t}`, `t=${t},v1=xyz`, `t=abc,v1=${signatureOf(secret, t, body)}`]) expect(verifySignatureHeader(bad, secret, body, t), String(bad)).toBe(false);
    // the same event re-signed later is still the same body, with a new timestamp and signature
    expect(signatureHeader(secret, t + 900, body)).not.toBe(h);
  });
});

describe("retries and the form", () => {
  test("5, 15, 60 minutes, then six hours; the eighth failure is the last", () => {
    expect(Array.from({ length: 7 }, (_, i) => backoffMinutes(i + 1))).toEqual([5, 15, 60, 360, 360, 360, 360]);
    expect(MAX_ATTEMPTS).toBe(8);
  });

  test("an address needs at least one of the eight events", () => {
    expect(WEBHOOK_EVENTS).toHaveLength(8);
    expect(cleanEndpointInput({ url: " https://x.example.com ", label: "  Books   sync ", events: ["payment.applied", "invoice.created"] })).toEqual({ ok: true, url: "https://x.example.com", label: "Books sync", events: ["invoice.created", "payment.applied"] });
    expect(cleanEndpointInput({ url: "https://x.example.com", label: "", events: [] })).toMatchObject({ ok: false });
    expect(cleanEndpointInput({ url: "https://x.example.com", label: "", events: ["load.created"] })).toMatchObject({ ok: false });
  });
});

describe("the pinned connection", () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ host: string | undefined; path: string | undefined; body: string; sig: string | undefined }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ host: req.headers.host, path: req.url, body, sig: req.headers["x-truelane-signature"] as string | undefined });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
          res.end();
        } else if (req.url === "/slow") setTimeout(() => res.end("late"), 500);
        else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test("connects to the checked address, never resolving the name again, and the Host is the name", async () => {
    const url = new URL(`http://never-resolves.invalid:${port}/hook`);
    const out = await pinnedTransport({ url, address: "127.0.0.1", family: 4, headers: { "content-type": "application/json", "x-truelane-signature": "t=1,v1=00" }, body: '{"a":1}' });
    expect(out).toEqual({ ok: true, status: 204 });
    expect(seen.at(-1)).toEqual({ host: `never-resolves.invalid:${port}`, path: "/hook", body: '{"a":1}', sig: "t=1,v1=00" });
  });

  test("a redirect is an answer, not a place to go: one request, the 302 kept", async () => {
    const before = seen.length;
    const out = await pinnedTransport({ url: new URL(`http://x.invalid:${port}/redirect`), address: "127.0.0.1", family: 4, headers: {}, body: "{}" });
    expect(out).toEqual({ ok: true, status: 302 });
    expect(seen.length).toBe(before + 1);
  });

  test("a receiver that does not answer in time is a failure", async () => {
    const out = await pinnedTransport({ url: new URL(`http://x.invalid:${port}/slow`), address: "127.0.0.1", family: 4, headers: {}, body: "{}", timeoutMs: 100 });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("in time") });
  });

  test("the pinned lookup answers the one address in both of Node's forms", () => {
    const look = pinnedLookup("93.184.216.34", 4) as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const got: unknown[][] = [];
    look("evil.example", {}, (...a) => got.push(a));
    look("evil.example", { all: true }, (...a) => got.push(a));
    (look as unknown as (h: string, cb: (...a: unknown[]) => void) => void)("evil.example", (...a) => got.push(a));
    expect(got).toEqual([[null, "93.184.216.34", 4], [null, [{ address: "93.184.216.34", family: 4 }]], [null, "93.184.216.34", 4]]);
  });
});

describe("every money write path queues its event, inside its own transaction", () => {
  const within = (file: string, fnStart: string, call: string, before: string) => {
    const text = src(file);
    const at = text.indexOf(fnStart);
    expect(at, `${file}: ${fnStart}`).toBeGreaterThan(-1);
    const body = text.slice(at, at + 12_000);
    const c = body.indexOf(call);
    expect(c, `${fnStart} queues ${call}`).toBeGreaterThan(-1);
    if (before) expect(c, `${call} comes before ${before} in ${fnStart}`).toBeLessThan(body.indexOf(before));
  };

  test("the choke points", () => {
    within("server/tl/invoice-records.ts", "export async function createInvoiceRecord", 'emitInvoice(tx, i.workspaceId, inv.id, "created")', "return inv.id");
    within("server/tl/invoice-records.ts", "export async function addInvoicePayment", 'emitPayment(tx, p.workspaceId, row, "applied")', "export async function closeInvoiceRecord");
    within("server/tl/invoice-records.ts", "export async function removeLastInvoicePayment", 'emitPayment(tx, last.workspaceId, last, "reversed"', "export async function voidInvoiceRecord");
    within("server/tl/invoice-records.ts", "export async function voidInvoiceRecord", 'emitInvoice(tx, inv.workspaceId, invoiceId, "voided"', "export async function setInvoiceFactoring");
    within("server/tl/invoicing.ts", "export async function issueCreditMemo", 'emitInvoice(tx, workspaceId, memo.id, "created"', "addInvoicePayment(tx");
    within("server/tl/invoicing.ts", "export async function voidCreditMemo", 'emitInvoice(tx, workspaceId, memoId, "voided"', "recordAudit(");
    within("server/tl/invoicing.ts", "export async function voidCreditMemo", 'emitPayment(tx, workspaceId, cp, "reversed"', "recordAudit(");
    within("server/tl/invoicing.ts", "async function voidSharedInvoice", 'emitInvoice(tx, workspaceId, invoiceId, "voided"', "return true;");
    within("server/tl/settlement.ts", "export async function finalizeSettlement", 'emitStatement(tx, workspaceId, id, "finalized"', 'action: "statement_finalized"');
    within("server/tl/settlement.ts", "export async function voidSettlement", 'emitStatement(tx, workspaceId, id, "voided"', 'action: "statement_voided"');
    // the record-level credit memo (an invoice of several loads) too
    const inv = src("server/tl/invoicing.ts");
    expect(inv.split('emitInvoice(tx, workspaceId, memo.id, "created"').length - 1).toBe(2);
    // nothing else writes or removes a payment or an invoice behind the outbox's back
    const server = ["server/tl/invoicing.ts", "server/tl/invoice-records.ts", "server/partners/factor-status-import.ts", "server/partners/qbo-sync.ts", "server/partners/factoring.ts", "server/tl/settlement.ts"].map((f) => [f, src(f)] as const);
    for (const [f, text] of server) {
      const creates = (text.match(/invoicePayment\.create\(/g) ?? []).length;
      expect(creates, `${f} creates payments`).toBe(f === "server/tl/invoice-records.ts" ? 1 : 0);
    }
  });

  test("emission opens no connection and delivery never runs inside a money write", () => {
    const emit = src("server/webhooks/emit.ts");
    for (const banned of ["fetch(", "transport", "http", "deliverDue"]) expect(emit, banned).not.toContain(banned);
    for (const f of ["server/tl/invoicing.ts", "server/tl/invoice-records.ts", "server/tl/settlement.ts"]) expect(src(f), f).not.toMatch(/deliverDue|webhooks\/deliver|webhooks\/transport/);
  });
});
