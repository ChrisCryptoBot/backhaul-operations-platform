import { afterEach, describe, expect, test } from "vitest";
import { API_SCOPES, DEFAULT_LIMIT, RATE_WINDOW_MS, bearerOf, cleanKeyInput, decodeCursor, encodeCursor, formatKey, maskKey, parseKey, readLimit, retryAfterSeconds } from "@/lib/api-keys";
import { decide, isPublicPath } from "@/lib/auth-route";
import { demoDecide } from "@/lib/demo-session";
import { DEMO_WORKSPACE_ID, ImplicitWorkspace, currentWorkspaceId, explicitTenancy, explicitWorkspaceId } from "@/server/tl/workspace";

/** Money plan Wave 7 step 2, pure: the key's shape, paging, cursors, the rate window, the public doors, and the explicit-tenancy seam. The database half is tests/integration/read-api.integration.test.ts. */
const SECRET = "A".repeat(42) + "z";

describe("a key's shape", () => {
  test("made and read back; only our exact shape is a key", () => {
    const key = formatKey("live", "ab12cd34", SECRET);
    expect(key).toBe(`tlk_live_ab12cd34_${SECRET}`);
    expect(parseKey(key)).toEqual({ prefix: "tlk_live_ab12cd34", mode: "live" });
    expect(parseKey(formatKey("test", "zz99zz99", "-_" + "x".repeat(41)))).toEqual({ prefix: "tlk_test_zz99zz99", mode: "test" });
    for (const bad of ["", "tlk_live_ab12cd34", `tlk_prod_ab12cd34_${SECRET}`, `tlk_live_AB12CD34_${SECRET}`, `tlk_live_ab12cd3_${SECRET}`, `tlk_live_ab12cd34_${SECRET}x`, `tlk_live_ab12cd34_${SECRET.slice(1)}`, `sk_live_${SECRET}`]) expect(parseKey(bad), bad).toBeNull();
    expect(maskKey("tlk_live_ab12cd34", "wxyz")).toBe("tlk_live_ab12cd34_…wxyz");
  });

  test("the Bearer header", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer   abc ")).toBe("abc");
    for (const bad of [null, undefined, "", "Basic abc", "Bearer", "Bearer a b", `Bearer ${"x".repeat(300)}`]) expect(bearerOf(bad), String(bad)).toBeNull();
  });

  test("a key needs a name and at least one thing to read, from the four", () => {
    expect(cleanKeyInput({ label: "  QuickBooks   reports ", scopes: ["loads", "invoices"] })).toEqual({ ok: true, label: "QuickBooks reports", scopes: ["invoices", "loads"] });
    expect(cleanKeyInput({ label: "x", scopes: ["loads"] })).toMatchObject({ ok: false });
    expect(cleanKeyInput({ label: "Apex", scopes: [] })).toMatchObject({ ok: false });
    expect(cleanKeyInput({ label: "Apex", scopes: ["drivers"] })).toMatchObject({ ok: false });
    expect(cleanKeyInput({ label: "Apex", scopes: "loads" })).toMatchObject({ ok: false });
    expect(API_SCOPES).toEqual(["invoices", "payments", "settlements", "loads"]);
  });
});

describe("paging", () => {
  test("limit: 50 by default, held to 1..100, refused when not a whole number", () => {
    expect(readLimit(null)).toEqual({ ok: true, limit: DEFAULT_LIMIT });
    expect(readLimit("")).toEqual({ ok: true, limit: 50 });
    expect(readLimit("0")).toEqual({ ok: true, limit: 1 });
    expect(readLimit("-5")).toEqual({ ok: true, limit: 1 });
    expect(readLimit("500")).toEqual({ ok: true, limit: 100 });
    expect(readLimit("25")).toEqual({ ok: true, limit: 25 });
    for (const bad of ["abc", "1.5", "1e3", "10x", "9999999"]) expect(readLimit(bad), bad).toMatchObject({ ok: false });
  });

  test("a cursor goes out and comes back the same; anything else is refused", () => {
    const c = { t: new Date("2026-11-13T18:00:00.123Z"), id: "cm123abc" };
    const raw = encodeCursor(c);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual({ ok: true, cursor: c });
    expect(decodeCursor(null)).toEqual({ ok: true, cursor: null });
    const forged = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const bad of ["not a cursor!", "abc", forged({ t: "yesterday", id: "x" }), forged({ t: c.t.toISOString(), id: "a b" }), forged({ t: c.t.toISOString() }), forged({ t: "2026-11-13T18:00:00Z", id: "x" }), "x".repeat(300)]) expect(decodeCursor(bad), bad).toMatchObject({ ok: false });
  });

  test("Retry-After is whole seconds to the end of the window, at least one", () => {
    const start = new Date("2026-11-13T18:00:00.000Z");
    expect(retryAfterSeconds(start, new Date(start.getTime() + 500))).toBe(60);
    expect(retryAfterSeconds(start, new Date(start.getTime() + 59_200))).toBe(1);
    expect(retryAfterSeconds(start, new Date(start.getTime() + RATE_WINDOW_MS + 5_000))).toBe(1);
  });
});

describe("the doors", () => {
  test("exactly the four read endpoints are public; the middleware lets them through with no one signed in, on either door", () => {
    for (const s of API_SCOPES) {
      const path = `/api/v1/${s}`;
      expect(isPublicPath(path), path).toBe(true);
      expect(decide({ path, method: "GET", userId: null, hasSession: false, wantsHtml: false })).toEqual({ kind: "next" });
      expect(demoDecide({ path, method: "GET", hasDemo: false, wantsHtml: false })).toEqual({ kind: "next" });
    }
    for (const p of ["/api/v1", "/api/v1/", "/api/v1/drivers", "/api/v1/invoices/x", "/api/v2/invoices", "/api/v1/invoicesx", "/x/api/v1/loads"]) expect(isPublicPath(p), p).toBe(false);
  });
});

describe("explicit tenancy", () => {
  const was = process.env.DESK_AUTH;
  afterEach(() => {
    if (was === undefined) delete process.env.DESK_AUTH;
    else process.env.DESK_AUTH = was;
  });

  test("inside it the request's default workspace is an error, sign-in off or on; outside it nothing changes", async () => {
    delete process.env.DESK_AUTH;
    expect(currentWorkspaceId()).toBe(DEMO_WORKSPACE_ID);
    await explicitTenancy("w-api", async () => {
      expect(explicitWorkspaceId()).toBe("w-api");
      expect(() => currentWorkspaceId()).toThrow(ImplicitWorkspace);
      await Promise.resolve();
      // across awaits and timers too
      await new Promise((r) => setTimeout(r, 5));
      expect(() => currentWorkspaceId()).toThrow(ImplicitWorkspace);
    });
    process.env.DESK_AUTH = "on";
    await explicitTenancy("w-api", async () => {
      expect(() => currentWorkspaceId()).toThrow(ImplicitWorkspace);
    });
    delete process.env.DESK_AUTH;
    expect(explicitWorkspaceId()).toBeNull();
    expect(currentWorkspaceId()).toBe(DEMO_WORKSPACE_ID);
    await expect(explicitTenancy("bad id!", async () => 1)).rejects.toThrow();
  });
});
