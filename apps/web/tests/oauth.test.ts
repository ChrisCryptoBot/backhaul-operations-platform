import { describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS, REFRESH_SKEW_MS, authorizeUrl, callbackPath, cleanAccountId, isOAuthProvider, needsRefresh, readTokenAnswer } from "@/lib/oauth";
import { contentHash } from "@/server/partners/external-refs";
import { originOf } from "@/server/partners/origin";
import { PROVIDERS, SECRET_ENV } from "@/truelane/partners/contract";

/** The pure rules of signing in to a partner company by OAuth, and of the external-id map (docs/MONEY_PLAN.md, Wave 3). */
const NOW = new Date("2026-12-01T12:00:00Z");

describe("signing in by OAuth", () => {
  it("is how QuickBooks connects, and its app keys are the contract's secret names", () => {
    expect(isOAuthProvider("quickbooks")).toBe(true);
    expect(isOAuthProvider("motive")).toBe(false);
    expect(isOAuthProvider("constructor")).toBe(false);
    expect(PROVIDERS.accounting).toEqual(["quickbooks"]);
    const def = OAUTH_PROVIDERS.quickbooks!;
    expect([def.clientIdEnv, def.clientSecretEnv]).toEqual(SECRET_ENV.quickbooks);
  });

  it("sends the person to the company's page with the code flow, the scope, the callback and the state", () => {
    const url = new URL(authorizeUrl(OAUTH_PROVIDERS.quickbooks!, { clientId: "ABC123", redirectUri: "https://desk.example.com/partners/oauth/quickbooks/callback", state: "s".repeat(43) }));
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "ABC123", response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: "https://desk.example.com/partners/oauth/quickbooks/callback", state: "s".repeat(43) });
    expect(callbackPath("quickbooks")).toBe("/partners/oauth/quickbooks/callback");
  });

  it("refreshes five minutes before the access token runs out, not sooner", () => {
    expect(needsRefresh(new Date(NOW.getTime() + REFRESH_SKEW_MS + 1000), NOW)).toBe(false);
    expect(needsRefresh(new Date(NOW.getTime() + REFRESH_SKEW_MS), NOW)).toBe(true);
    expect(needsRefresh(new Date(NOW.getTime() - 1000), NOW)).toBe(true);
  });

  it("reads a token answer only when both tokens and a lifetime are there", () => {
    const good = readTokenAnswer({ access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: "8640000", scope: "com.intuit.quickbooks.accounting" }, NOW);
    expect(good).toEqual({ accessToken: "at", refreshToken: "rt", accessExpiresAt: new Date("2026-12-01T13:00:00Z"), refreshExpiresAt: new Date("2027-03-11T12:00:00Z"), scope: "com.intuit.quickbooks.accounting" });
    expect(readTokenAnswer({ access_token: "at", expires_in: 3600 }, NOW)).toBeNull();
    expect(readTokenAnswer({ access_token: "at", refresh_token: "rt", expires_in: 0 }, NOW)).toBeNull();
    expect(readTokenAnswer({ access_token: "a\nb", refresh_token: "rt", expires_in: 3600 }, NOW)).toBeNull();
    expect(readTokenAnswer("access_token=at", NOW)).toBeNull();
    expect(readTokenAnswer({ access_token: "at", refresh_token: "rt", expires_in: 60 }, NOW)?.refreshExpiresAt).toBeNull();
  });

  it("keeps a company's account id only when it is a plain id", () => {
    expect(cleanAccountId("9130350000000000")).toBe("9130350000000000");
    expect(cleanAccountId("../../etc")).toBeNull();
    expect(cleanAccountId("")).toBeNull();
    expect(cleanAccountId(null)).toBeNull();
    expect(cleanAccountId("x".repeat(65))).toBeNull();
  });

  it("knows the desk's own address from the request, behind a proxy or not, and refuses a strange host", () => {
    expect(originOf(new Headers({ host: "localhost:3101" }))).toBe("http://localhost:3101");
    expect(originOf(new Headers({ host: "internal:8080", "x-forwarded-host": "desk.example.com", "x-forwarded-proto": "https" }))).toBe("https://desk.example.com");
    expect(originOf(new Headers({ host: "desk.example.com" }))).toBe("https://desk.example.com");
    expect(originOf(new Headers({ host: "evil.com/path" }))).toBeNull();
    expect(originOf(new Headers({}))).toBeNull();
  });
});

describe("the external-id map's fingerprint", () => {
  it("is the same whatever order the keys came in, and changes when a value does", () => {
    expect(contentHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(contentHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
    expect(contentHash({ on: new Date("2026-12-01T00:00:00Z") })).toBe(contentHash({ on: "2026-12-01T00:00:00.000Z" }));
  });
});
