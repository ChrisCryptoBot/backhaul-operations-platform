import { randomBytes } from "node:crypto";
import { err, ok, type PartnerResult } from "@/truelane/partners/contract";
import { readTokenAnswer, type TokenSet } from "@/lib/oauth";
import { notImplemented } from "../not-implemented";

/**
 * Trading a sign-in code, or a refresh token, for tokens (docs/MONEY_PLAN.md, Wave 3). The same switch as every partner (sandbox.ts): an app client id that starts with `sandbox_` runs the
 * simulator here, with no network call; any other answers "not implemented" until a company is chosen and its live exchange written (no live endpoint anywhere, by design).
 *
 * A refresh the company refuses for good (the refresh token expired or was revoked: OAuth's `invalid_grant`) is told apart from one that failed for now, because the first means the fleet
 * has to sign in again and the second only means try later.
 */
export type ExchangeResult = PartnerResult<TokenSet> & { revoked?: boolean };
export type OAuthExchanger = {
  /** Where the person's browser goes to sign in: the company's page (live), or straight back to the desk's callback with a code (simulator). */
  signInUrl(args: { provider: string; clientId: string; redirectUri: string; state: string; companyUrl: string }): string;
  exchangeCode(args: { provider: string; code: string; redirectUri: string }, now: Date): Promise<ExchangeResult>;
  refresh(args: { provider: string; refreshToken: string }, now: Date): Promise<ExchangeResult>;
};

export const liveExchanger: OAuthExchanger = {
  signInUrl: ({ companyUrl }) => companyUrl,
  exchangeCode: async ({ provider }) => notImplemented(provider),
  refresh: async ({ provider }) => notImplemented(provider)
};

/** Codes and refresh tokens the simulator hands out carry these words, so a test can make the company refuse one: a code with `deny` is refused, a refresh token with `revoked` is refused for good. */
export const SANDBOX_REALM = "9130350000000000";
const token = (kind: string) => `sandbox_${kind}_${randomBytes(12).toString("base64url")}`;

export const sandboxExchanger: OAuthExchanger = {
  signInUrl: ({ redirectUri, state }) => {
    // The simulator's "company" approves at once and names one sandbox company file, as QuickBooks sends a realm id with the code.
    const q = new URLSearchParams({ code: token("code"), state, realmId: SANDBOX_REALM });
    return `${redirectUri}?${q.toString()}`;
  },
  exchangeCode: async ({ code }, now) => {
    if (!code.startsWith("sandbox_code_")) return err("bad_request", "The sign-in code was not one the simulator gave.");
    if (code.includes("deny")) return err("upstream_error", "The company refused the sign-in code.");
    return answer(now);
  },
  refresh: async ({ refreshToken }, now) => {
    if (refreshToken.includes("revoked")) return { ...err("upstream_error", "The company refused the refresh token: sign in again."), revoked: true };
    return answer(now);
  }
};

function answer(now: Date): ExchangeResult {
  // Intuit's lifetimes: an hour for the access token, 100 days for the refresh token.
  const set = readTokenAnswer({ access_token: token("access"), refresh_token: token("refresh"), expires_in: 3600, x_refresh_token_expires_in: 8_640_000, token_type: "bearer", scope: "com.intuit.quickbooks.accounting" }, now);
  return set ? ok(set) : err("upstream_error", "The simulator's answer could not be read.");
}
