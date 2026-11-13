import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { RATE_LIMIT } from "@/lib/api-keys";
import { GET as getInvoices } from "@/app/(public)/api/v1/invoices/route";
import { GET as getLoads } from "@/app/(public)/api/v1/loads/route";
import { GET as getPayments } from "@/app/(public)/api/v1/payments/route";
import { GET as getSettlements } from "@/app/(public)/api/v1/settlements/route";
import { serveRead } from "@/server/api/handler";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/api/keys";

/**
 * Money plan Wave 7 step 2 on the demo database: the partner read API end to end, through the real route handlers, in workspaces of their own. A key reads only its own fleet's rows, only what
 * its scopes allow, only on a plan that has the API, and only 60 times a minute (counted exactly under a burst); a revoked key is refused; no cookie or session is involved, sign-in on or off;
 * pages are stable while rows are added; and no driver's personal details leave the desk.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const A = "w7-api-a";
const B = "w7-api-b";
const S = "w7-api-starter";
const BASE = "http://desk.test/api/v1";
const T0 = new Date("2026-10-01T12:00:00.000Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);
const keys: Record<string, string> = {};
const savedAuth = process.env.DESK_AUTH;

const req = (pathAndQuery: string, key?: string | null, extra: Record<string, string> = {}) => new Request(`${BASE}/${pathAndQuery}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra } });
const body = async (r: Response) => (await r.json()) as { data: Array<Record<string, unknown>>; next_cursor: string | null; has_more: boolean; timezone: string; request_id: string; error?: { code: string; message: string } };
const resetWindow = async (key: string) => prisma.partnerApiKey.updateMany({ where: { prefix: key.split("_").slice(0, 3).join("_") }, data: { windowStart: null, windowCount: 0, lastUsedAt: null } });

const clean = async () => {
  for (const id of [A, B, S]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.settlement.deleteMany({ where: { workspaceId: id } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: id } } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
};

describe.skipIf(!run)("Wave 7 step 2: the partner read API", () => {
  let driverA = "";
  beforeAll(async () => {
    delete process.env.DESK_AUTH;
    await clean();
    await prisma.workspace.create({ data: { id: A, name: "W7 API A", plan: "pro", timezone: "America/New_York" } });
    await prisma.workspace.create({ data: { id: B, name: "W7 API B", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: S, name: "W7 API starter" } });
    driverA = (await prisma.driver.create({ data: { workspaceId: A, name: "Private Person", phone: "555-0100", email: "private@example.com", cdlExpiry: at(900_000), medicalCardExpiry: at(900_000), payrollEmployeeId: "emp-secret", payrollWorkerType: "employee" } })).id;
    // Five invoices in A, two sharing one creation time (the id breaks the tie), and one in B.
    const made = [at(0), at(1), at(1), at(2), at(3)];
    for (const [i, t] of made.entries()) {
      const inv = await prisma.invoice.create({ data: { workspaceId: A, number: `A-${i + 1}`, issuedAt: t, total: "1234.50", paidTotal: i === 0 ? "1234.50" : 0, billToName: "Broker Co", billToMc: "MC1", billToEmail: "ap@broker.example", billToPhone: "555-0199", createdAt: t } });
      if (i === 0) await prisma.invoicePayment.create({ data: { workspaceId: A, invoiceId: inv.id, amount: "1234.50", paidAt: t, method: "ach", source: "desk", createdAt: t } });
    }
    await prisma.invoice.create({ data: { workspaceId: B, number: "B-1", issuedAt: at(0), total: 99, createdAt: at(0) } });
    // Loads: one assigned to the driver, one deleted.
    const load = await prisma.load.create({ data: { workspaceId: A, loadNumber: "L-1", status: "completed", quotedRevenue: "2000.00", loadedMiles: "512.3456", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", createdAt: at(0) } });
    await prisma.assignment.create({ data: { loadId: load.id, driverId: driverA, payKind: "percent", payRate: "0.25" } });
    await prisma.load.create({ data: { workspaceId: A, loadNumber: "L-GONE", status: "draft", deletedAt: at(5), createdAt: at(1) } });
    // Statements: a draft (not listed) and a final one.
    await prisma.settlement.create({ data: { workspaceId: A, driverId: driverA, number: "ST-DRAFT", status: "draft", periodStart: at(-10_080), periodEnd: at(0), createdAt: at(0) } });
    await prisma.settlement.create({ data: { workspaceId: A, driverId: driverA, number: "ST-1", status: "final", periodStart: new Date("2026-09-21"), periodEnd: new Date("2026-09-27"), total: "800.00", finalizedAt: at(2), payrollReference: "pending:abc", payrollSentAt: at(2), createdAt: at(1) } });

    for (const [name, ws, scopes] of [["aAll", A, ["invoices", "payments", "settlements", "loads"]], ["aInv", A, ["invoices"]], ["b", B, ["invoices", "loads"]]] as const) {
      const out = await createApiKey({ label: `Key ${name}`, scopes: [...scopes] }, "Chris", T0, ws, "test");
      if (!out.ok) throw new Error(out.error);
      keys[name] = out.key;
    }
  });
  afterAll(async () => {
    if (savedAuth === undefined) delete process.env.DESK_AUTH;
    else process.env.DESK_AUTH = savedAuth;
    await clean();
  });

  test("a key is shown once and never stored: the row keeps a fingerprint, a prefix and the last four; the trail says it was made", async () => {
    const row = await prisma.partnerApiKey.findFirstOrThrow({ where: { workspaceId: A, label: "Key aAll" } });
    expect(keys.aAll).toMatch(/^tlk_test_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(row)).not.toContain(keys.aAll!.split("_").slice(3).join("_"));
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.aAll!.startsWith(row.prefix)).toBe(true);
    expect(keys.aAll!.endsWith(row.last4)).toBe(true);
    const listed = await listApiKeys(A);
    expect(JSON.stringify(listed)).not.toContain(row.hash);
    expect(await prisma.auditEvent.count({ where: { workspaceId: A, action: "api_key_created" } })).toBe(2);
    // the plan: Starter has no read API, so no key can be made there
    expect(await createApiKey({ label: "Nope", scopes: ["invoices"] }, "Chris", T0, S, "test")).toMatchObject({ ok: false, error: expect.stringContaining("Pro plan") });
  });

  test("a key reads its own fleet only", async () => {
    const a = await body(await getInvoices(req("invoices", keys.aAll)));
    expect(a.data.map((r) => r.number).sort()).toEqual(["A-1", "A-2", "A-3", "A-4", "A-5"]);
    const b = await body(await getInvoices(req("invoices", keys.b)));
    expect(b.data.map((r) => r.number)).toEqual(["B-1"]);
    expect((await body(await getLoads(req("loads", keys.b)))).data).toEqual([]);
    await resetWindow(keys.aAll!);
    await resetWindow(keys.b!);
  });

  test("the shape: decimal text for money, ISO UTC times, the fleet's zone named, a request id everywhere", async () => {
    const res = await getInvoices(req("invoices?limit=1", keys.aAll));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{24}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-ratelimit-limit")).toBe(String(RATE_LIMIT));
    const j = await body(res);
    expect(j.request_id).toBe(res.headers.get("x-request-id"));
    expect(j.timezone).toBe("America/New_York");
    expect(j.data[0]).toMatchObject({ object: "invoice", number: "A-1", total: "1234.50", paid_total: "1234.50", issued_at: "2026-10-01T12:00:00.000Z", bill_to: { name: "Broker Co", mc: "MC1" } });
    expect(JSON.stringify(j.data[0])).not.toMatch(/ap@broker|555-0199/);
    const pay = await body(await getPayments(req("payments", keys.aAll)));
    expect(pay.data).toEqual([expect.objectContaining({ object: "payment", amount: "1234.50", method: "ach", source: "desk" })]);
    await resetWindow(keys.aAll!);
  });

  test("no driver's personal details: loads and statements name the driver by id; deleted loads and draft statements are not listed", async () => {
    const loads = await body(await getLoads(req("loads", keys.aAll)));
    expect(loads.data.map((l) => l.load_number)).toEqual(["L-1"]);
    expect(loads.data[0]).toMatchObject({ driver_id: driverA, rate: "2000.00", loaded_miles: "512.3", origin: "Dallas, TX" });
    const st = await body(await getSettlements(req("settlements", keys.aAll)));
    expect(st.data.map((s) => s.number)).toEqual(["ST-1"]);
    expect(st.data[0]).toMatchObject({ driver_id: driverA, total: "800.00", period_start: "2026-09-21", period_end: "2026-09-27", payroll_reference: null, payroll_sent_at: null });
    const all = JSON.stringify([loads, st]);
    for (const secret of ["Private Person", "555-0100", "private@example.com", "emp-secret", "employee"]) expect(all, secret).not.toContain(secret);
    await resetWindow(keys.aAll!);
  });

  test("refusals: no key, a malformed key, a wrong secret, a key without the scope, a revoked key; each JSON with a request id", async () => {
    const check = async (res: Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      expect(res.headers.get("x-request-id")).toMatch(/^req_/);
      const j = await body(res);
      expect(j.error?.code).toBe(code);
      expect(j.request_id).toBe(res.headers.get("x-request-id"));
      expect(j.data).toBeUndefined();
    };
    await check(await getInvoices(req("invoices", null)), 401, "unauthenticated");
    await check(await getInvoices(req("invoices", "tlk_live_nope")), 401, "unauthenticated");
    const wrong = keys.aAll!.slice(0, -4) + (keys.aAll!.endsWith("AAAA") ? "BBBB" : "AAAA");
    await check(await getInvoices(req("invoices", wrong)), 401, "unauthenticated");
    await check(await getLoads(req("loads", keys.aInv)), 403, "forbidden_scope");
    await check(await getInvoices(req("invoices?limit=abc", keys.aInv)), 400, "bad_request");
    await check(await getInvoices(req("invoices?after=garbage!", keys.aInv)), 400, "bad_request");
    expect((await getInvoices(req("invoices", null))).headers.get("www-authenticate")).toContain("Bearer");

    const row = await prisma.partnerApiKey.findFirstOrThrow({ where: { workspaceId: A, label: "Key aInv" } });
    expect(await revokeApiKey(row.id, "Chris", at(10), A)).toEqual({ ok: true, changed: true });
    expect(await revokeApiKey(row.id, "Chris", at(11), A)).toEqual({ ok: true, changed: false });
    expect(await revokeApiKey(row.id, "Mallory", at(11), B)).toMatchObject({ ok: false }); // another fleet cannot even see it
    await check(await getInvoices(req("invoices", keys.aInv)), 401, "revoked");
    expect(await prisma.auditEvent.count({ where: { workspaceId: A, action: "api_key_revoked" } })).toBe(1);
  });

  test("the plan: a fleet moved below Pro is refused, with its key still in place", async () => {
    await prisma.workspace.update({ where: { id: A }, data: { plan: "growth" } });
    const res = await getInvoices(req("invoices", keys.aAll));
    expect(res.status).toBe(403);
    expect((await body(res)).error?.code).toBe("plan");
    await prisma.workspace.update({ where: { id: A }, data: { plan: "pro" } });
    expect((await getInvoices(req("invoices", keys.aAll))).status).toBe(200);
    await resetWindow(keys.aAll!);
  });

  test("sign-in on, no session or cookie: a key still reads, and only its own fleet", async () => {
    process.env.DESK_AUTH = "on";
    try {
      const res = await getInvoices(req("invoices", keys.b, { cookie: "desk-demo=admin; desk-workspace=w7-api-a" }));
      expect(res.status).toBe(200);
      expect((await body(res)).data.map((r) => r.number)).toEqual(["B-1"]);
    } finally {
      delete process.env.DESK_AUTH;
    }
    await resetWindow(keys.b!);
  });

  test("60 a minute, counted exactly under a burst; Retry-After; a new minute opens again; last used is written at most once a minute", async () => {
    await resetWindow(keys.b!);
    const now = new Date("2026-11-13T18:00:00.000Z");
    const burst = await Promise.all(Array.from({ length: RATE_LIMIT + 15 }, () => serveRead(req("invoices", keys.b), "invoices", { now: () => now })));
    const codes = burst.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(RATE_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
    const limited = burst.find((r) => r.status === 429)!;
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-request-id")).toMatch(/^req_/);
    expect((await body(limited)).error?.code).toBe("rate_limited");
    const row = await prisma.partnerApiKey.findFirstOrThrow({ where: { workspaceId: B } });
    expect(row.windowCount).toBe(RATE_LIMIT + 15);
    expect(row.lastUsedAt?.toISOString()).toBe(now.toISOString());

    const later = new Date(now.getTime() + 30_000);
    const stillShut = await serveRead(req("invoices", keys.b), "invoices", { now: () => later });
    expect(stillShut.status).toBe(429);
    expect(stillShut.headers.get("retry-after")).toBe("30");
    expect((await prisma.partnerApiKey.findFirstOrThrow({ where: { workspaceId: B } })).lastUsedAt?.toISOString()).toBe(now.toISOString()); // not rewritten inside the minute

    const next = new Date(now.getTime() + 61_000);
    const open = await serveRead(req("invoices", keys.b), "invoices", { now: () => next });
    expect(open.status).toBe(200);
    expect(open.headers.get("x-ratelimit-remaining")).toBe(String(RATE_LIMIT - 1));
    expect((await prisma.partnerApiKey.findFirstOrThrow({ where: { workspaceId: B } })).lastUsedAt?.toISOString()).toBe(next.toISOString());
    await resetWindow(keys.b!);
  });

  test("paging is stable: oldest first, ties by id, no row twice or missed, rows added while paging come at the end", async () => {
    await resetWindow(keys.aAll!);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const j = await body(await getInvoices(req(`invoices?limit=2${cursor ? `&after=${cursor}` : ""}`, keys.aAll)));
      seen.push(...j.data.map((r) => String(r.number)));
      expect(j.has_more).toBe(j.next_cursor != null);
      cursor = j.next_cursor;
      pages += 1;
      // a row made after the first page is read lands at the end, once
      if (pages === 1) await prisma.invoice.create({ data: { workspaceId: A, number: "A-NEW", issuedAt: at(20), total: 1, createdAt: at(20) } });
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen[0]).toBe("A-1");
    expect(seen[seen.length - 1]).toBe("A-NEW");
    // the two made at the same moment come in id order
    const tied = await prisma.invoice.findMany({ where: { workspaceId: A, createdAt: at(1) }, orderBy: { id: "asc" }, select: { number: true } });
    expect(seen.slice(1, 3)).toEqual(tied.map((t) => t.number));
    // limit is held to 1..100
    const one = await body(await getInvoices(req("invoices?limit=0", keys.aAll)));
    expect(one.data).toHaveLength(1);
    await resetWindow(keys.aAll!);
  });
});
