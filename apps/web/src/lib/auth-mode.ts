export function isAuthBypassed(): boolean {
  // Hard guarantee: auth is never bypassed in production, even if BYPASS_AUTH leaks into
  // the environment. Mirrors the prod guard on AUTO_PROVISION_AUTH_USER in lib/access.ts.
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return process.env.BYPASS_AUTH === "true";
}

export function isWriteBypassed(): boolean {
  return isAuthBypassed() && process.env.BYPASS_AUTH_WRITES === "true";
}
