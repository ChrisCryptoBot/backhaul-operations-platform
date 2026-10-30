import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * The only file that talks to the sign-in provider (Clerk). Everything else asks `clerkSeam`, so a test can stand in for a signed-in person and nothing else in the desk
 * imports the provider. Nothing here runs unless DESK_AUTH=on.
 */
export type ClerkProfile = { id: string; name: string | null; email: string | null; emailVerified: boolean };

export const clerkSeam = {
  /** The signed-in user's id for this request, or null. Synchronous: the provider's own session check, no network. */
  userId(): string | null {
    try {
      return auth().userId ?? null;
    } catch {
      return null;
    }
  },
  /** Who the signed-in user is (name, primary email and whether the provider has verified it). One call to the provider; used only when a desk session is made. */
  async profile(): Promise<ClerkProfile | null> {
    const u = await currentUser();
    if (!u) return null;
    const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.username || null;
    return { id: u.id, name, email: primary?.emailAddress?.toLowerCase() ?? null, emailVerified: primary?.verification?.status === "verified" };
  }
};
