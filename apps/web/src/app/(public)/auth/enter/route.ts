import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth-route";
import type { Role } from "@/lib/roles";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/session-cookie";
import { clerkSeam } from "@/server/tl/clerk";
import { authOn } from "@/server/tl/identity";
import { memberForSignIn } from "@/server/tl/members";
import { signSession, usableSecret } from "@/server/tl/session-token";

/**
 * Making a desk session. A person who has signed in to the provider lands here: it looks them up in the member table (binding their user id to the row an admin added for their
 * email, the first time), and if they are on a desk gives them the signed session cookie and sends them where they were going; if nobody added them, to the page that says so.
 * Open to a signed-in person only (the middleware turns anyone else away), and the cookie it makes is useless without that same sign-in.
 */
export async function GET(req: NextRequest) {
  const go = (path: string) => NextResponse.redirect(new URL(path, req.url));
  if (!authOn()) return go("/loads");
  const secret = process.env.DESK_SESSION_SECRET;
  if (!usableSecret(secret)) return NextResponse.json({ ok: false, error: "Sign-in is on, but DESK_SESSION_SECRET is not set (32 characters or more)." }, { status: 503 });
  const profile = await clerkSeam.profile();
  if (!profile) return go("/sign-in");
  const member = await memberForSignIn(profile);
  if (!member) return go("/no-workspace");
  const res = go(safeNext(req.nextUrl.searchParams.get("next")));
  res.cookies.set(SESSION_COOKIE, signSession({ uid: profile.id, ws: member.workspaceId, role: member.role as Role, name: member.name, email: profile.email ?? member.email }, secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
  return res;
}
