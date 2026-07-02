export function getClerkPublishableKey(): string {
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY ?? "";
}

export function hasValidClerkPublishableKey(key: string): boolean {
  return /^pk_(test|live)_/.test(key);
}

/**
 * Whether Clerk is active in this environment. Mirrors the layout's condition for
 * mounting <ClerkProvider>, so client components can gate Clerk hooks/components and
 * safely no-op in dev bypass (no key configured → no provider mounted).
 */
export function isClerkEnabled(): boolean {
  return hasValidClerkPublishableKey(getClerkPublishableKey());
}
