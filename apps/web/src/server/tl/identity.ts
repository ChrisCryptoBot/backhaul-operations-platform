import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import type { Grant, Role } from "@/lib/roles";
import { clerkSeam } from "./clerk";
import { verifySession } from "./session-token";

/**
 * Who is on the desk, read without waiting: the sign-in provider's user for this request, matched to the desk's own session cookie (signed, and made for that same user).
 * Sign-in is DESK_AUTH=on; with it off there is no identity and the desk is the demo's, as it always was. This is what the tenancy seam and the audit actor read; whether the
 * person may still be here (still a member, and of what role) is `checkAccess` in ./access.ts, which asks the member table.
 */
export const authOn = (): boolean => process.env.DESK_AUTH === "on";

/** `grants` are what an admin gave the person on top of their role. The session cookie carries none: they are read from the member table on every check (access.ts). */
export type Identity = { userId: string; workspaceId: string; role: Role; grants: Grant[]; name: string; email: string | null };

/** The signed-in person, or null: not signed in to the provider, no desk session, a session made for someone else, a bad signature or an old one. Always null with sign-in off. */
export function sessionIdentity(): Identity | null {
  if (!authOn()) return null;
  try {
    const uid = clerkSeam.userId();
    if (!uid) return null;
    const p = verifySession(cookies().get(SESSION_COOKIE)?.value, process.env.DESK_SESSION_SECRET);
    if (!p || p.uid !== uid) return null;
    return { userId: p.uid, workspaceId: p.ws, role: p.role, grants: [], name: p.name, email: p.email };
  } catch {
    return null;
  }
}

export const DESK_ACTOR = "Dispatcher";

/** The name an audit event is written under: the signed-in person's, or "Dispatcher" with sign-in off (or outside a request, a script or a test). */
export function currentActor(): string {
  return sessionIdentity()?.name || DESK_ACTOR;
}

/** Thrown by the tenancy seam when sign-in is on and nobody is signed in to the desk: nothing may fall back to the demo's data. */
export class NotSignedIn extends Error {
  constructor() {
    super("Sign in to use the desk.");
    this.name = "NotSignedIn";
  }
}
