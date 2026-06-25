export function getClerkPublishableKey(): string {
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY ?? "";
}

export function hasValidClerkPublishableKey(key: string): boolean {
  return /^pk_(test|live)_/.test(key);
}
