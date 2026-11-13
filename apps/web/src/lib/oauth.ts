/**
 * Partner companies that connect by OAuth 2 instead of a pasted key (docs/MONEY_PLAN.md, Wave 3). Pure: no database, no network, no environment.
 *
 * The flow (authorization code): the desk sends the person to the company's sign-in page with a one-time `state`; the company sends them back to the desk's callback with a `code` (and,
 * for QuickBooks, the `realmId` of the company file they chose); the desk trades the code for an access token (about an hour) and a refresh token (about 100 days, replaced on each use).
 * The app's own client id and secret are the provider's secrets in the contract (QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET): a fleet never types a key for these companies.
 */
export type OAuthProvider = {
  /** The company's sign-in page. Only ever opened in the person's browser. */
  authorizeUrl: string;
  scopes: readonly string[];
  /** The contract's secret names for the app's client id and secret, in that order. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** The query parameter the company adds to the callback naming the account chosen, or null when the token answer carries no account id. */
  accountParam: string | null;
};

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  quickbooks: {
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    scopes: ["com.intuit.quickbooks.accounting"],
    clientIdEnv: "QUICKBOOKS_CLIENT_ID",
    clientSecretEnv: "QUICKBOOKS_CLIENT_SECRET",
    accountParam: "realmId"
  }
};

export const isOAuthProvider = (provider: string): boolean => Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, provider);

/** The page the company's sign-in sends the person back to, on this desk. */
export const callbackPath = (provider: string): string => `/partners/oauth/${encodeURIComponent(provider)}/callback`;

/** How long a sign-in may take before its state is refused. */
export const STATE_TTL_MS = 10 * 60_000;

/** An access token is refreshed this long before it runs out, so a call that starts just before the end does not fail in the middle. */
export const REFRESH_SKEW_MS = 5 * 60_000;

/** How long one call may hold the right to refresh: long enough for the company to answer, short enough that a call that died does not block the next. */
export const REFRESH_LEASE_MS = 30_000;

export function authorizeUrl(def: OAuthProvider, args: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: args.clientId, response_type: "code", scope: def.scopes.join(" "), redirect_uri: args.redirectUri, state: args.state });
  return `${def.authorizeUrl}?${q.toString()}`;
}

export const needsRefresh = (accessExpiresAt: Date, now: Date): boolean => accessExpiresAt.getTime() - REFRESH_SKEW_MS <= now.getTime();

export type TokenSet = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date | null; scope: string | null };

/**
 * A company's token answer (RFC 6749 section 5.1, plus Intuit's `x_refresh_token_expires_in`), checked: both tokens present and plain text, lifetimes positive. Anything else is null, so a
 * malformed answer is "the sign-in did not work", never a half-stored token.
 */
export function readTokenAnswer(body: unknown, now: Date): TokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" && v.length <= 4096 && !/[\r\n]/.test(v) ? v.trim() : null);
  const secs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && /^\d+$/.test(v) && v !== "0" ? Number.parseInt(v, 10) : null);
  const accessToken = text(b.access_token);
  const refreshToken = text(b.refresh_token);
  const expiresIn = secs(b.expires_in);
  if (!accessToken || !refreshToken || expiresIn == null) return null;
  const refreshIn = secs(b.x_refresh_token_expires_in);
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(now.getTime() + expiresIn * 1000),
    refreshExpiresAt: refreshIn != null ? new Date(now.getTime() + refreshIn * 1000) : null,
    scope: typeof b.scope === "string" ? b.scope.slice(0, 500) : null
  };
}

/** A company's id for an account (QuickBooks' realm id) as it may be kept and sent back: digits, letters, dashes and underscores, at most 64. */
export const cleanAccountId = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
