import { describe, expect, test } from "vitest";
import { decide, isPublicPath, safeNext } from "@/lib/auth-route";
import { SESSION_TTL_SECONDS, peekSession } from "@/lib/session-cookie";
import { BUDGETS, overBudget, resetBudgets } from "@/server/tl/budget";
import { MIN_SECRET_LENGTH, signSession, usableSecret, verifySession } from "@/server/tl/session-token";

const SECRET = "s".repeat(MIN_SECRET_LENGTH);
const who = { uid: "user_1", ws: "ws-1", role: "dispatcher" as const, name: "Pat Lee", email: "pat@example.com" };
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

describe("the desk session cookie", () => {
  test("a cookie signed with the secret reads back, for an hour", () => {
    const token = signSession(who, SECRET, NOW);
    expect(verifySession(token, SECRET, NOW)).toMatchObject({ ...who, exp: NOW / 1000 + SESSION_TTL_SECONDS });
    expect(verifySession(token, SECRET, NOW + (SESSION_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + (SESSION_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  test("an edited payload, a swapped signature, another secret, a truncated or an empty cookie all read as nothing", () => {
    const token = signSession(who, SECRET, NOW);
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...who, role: "admin", exp: NOW / 1000 + 3600 })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${body}.${"0".repeat(sig.length)}`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, "t".repeat(MIN_SECRET_LENGTH), NOW)).toBeNull();
    expect(verifySession(`${body}.zz`, SECRET, NOW)).toBeNull();
    expect(verifySession(body, SECRET, NOW)).toBeNull();
    expect(verifySession("", SECRET, NOW)).toBeNull();
    expect(verifySession(undefined, SECRET, NOW)).toBeNull();
  });

  test("with no usable secret nothing is signed and nothing verifies: an unsigned desk refuses everyone", () => {
    expect(usableSecret(undefined)).toBe(false);
    expect(usableSecret("short")).toBe(false);
    expect(() => signSession(who, "short", NOW)).toThrow(/DESK_SESSION_SECRET/);
    expect(verifySession(signSession(who, SECRET, NOW), undefined, NOW)).toBeNull();
    expect(verifySession(signSession(who, SECRET, NOW), "short", NOW)).toBeNull();
  });

  test("a role outside the three is not a session", () => {
    const body = Buffer.from(JSON.stringify({ uid: "u", ws: "w", role: "god", name: "x", exp: NOW / 1000 + 60 })).toString("base64url");
    expect(peekSession(`${body}.x`, NOW)).toBeNull();
  });

  test("the middleware can read who a cookie says it is, and when it ends, without the secret", () => {
    const token = signSession(who, SECRET, NOW);
    expect(peekSession(token, NOW)).toMatchObject({ uid: "user_1", ws: "ws-1" });
    expect(peekSession(token, NOW + 2 * 3_600_000)).toBeNull();
    expect(peekSession("not a cookie", NOW)).toBeNull();
    expect(peekSession(undefined, NOW)).toBeNull();
  });
});

describe("the front door", () => {
  const base = { method: "GET", userId: null as string | null, hasSession: false, wantsHtml: true };

  test("the splash, sign-in, sign-up, enterprise, no-desk and sign-out pages are open to anyone; the desk is not", () => {
    for (const p of ["/", "/sign-in", "/sign-in/factor-one", "/sign-up", "/sign-up/thanks", "/enterprise", "/enterprise/thanks", "/no-workspace", "/auth/leave"]) expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/loads", "/settings", "/settings/requests", "/export/loads", "/geo/measure", "/messages/send", "/auth/enter", "/signin-evil", "/enterprises"]) expect(isPublicPath(p), p).toBe(false);
  });

  test("nobody signed in: a page goes to sign-in, a fetch or a change gets a 401", () => {
    expect(decide({ ...base, path: "/loads" })).toEqual({ kind: "sign_in" });
    expect(decide({ ...base, path: "/export/loads", wantsHtml: false })).toEqual({ kind: "unauthorized" });
    expect(decide({ ...base, path: "/loads", method: "POST" })).toEqual({ kind: "unauthorized" });
    expect(decide({ ...base, path: "/sign-in" })).toEqual({ kind: "next" });
  });

  test("signed in to the provider with no desk session: a page makes one and comes back; the enter route itself goes through", () => {
    expect(decide({ ...base, userId: "u", path: "/loads", search: "?tab=open" })).toEqual({ kind: "enter", next: "/loads?tab=open" });
    expect(decide({ ...base, userId: "u", path: "/auth/enter" })).toEqual({ kind: "next" });
    expect(decide({ ...base, userId: "u", path: "/loads", hasSession: true })).toEqual({ kind: "next" });
  });

  test("after signing in, only a path on this desk is followed", () => {
    expect(safeNext("/loads/abc?x=1")).toBe("/loads/abc?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "loads", "", null, undefined, "/loads\n", "/auth/enter"]) expect(safeNext(bad as string | null), String(bad)).toBe("/loads");
  });
});

describe("the daily budget on paid lookups", () => {
  test("the day's allowance is given, then refused with a 429; another desk and a new day start fresh", async () => {
    resetBudgets();
    const day = new Date("2026-10-30T10:00:00Z");
    for (let i = 0; i < BUDGETS.eia; i++) expect(overBudget("eia", "ws-a", day)).toBeNull();
    const over = overBudget("eia", "ws-a", day);
    expect(over?.status).toBe(429);
    expect(await over!.json()).toMatchObject({ ok: false });
    expect(overBudget("eia", "ws-b", day)).toBeNull();
    expect(overBudget("eia", "ws-a", new Date("2026-10-31T00:30:00Z"))).toBeNull();
    resetBudgets();
  });
});
