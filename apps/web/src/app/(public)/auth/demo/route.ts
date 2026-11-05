import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/auth-route";
import { DEMO_COOKIE, DEMO_TTL_SECONDS, DEMO_USERS, demoLoginOn } from "@/lib/demo-session";
import { ZONE_COOKIE } from "@/lib/tz";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

/**
 * The demo's sign-in: the sign-in page's "Use demo credentials" button posts here. It checks nothing (there are no accounts) and makes the demo cookie, then goes to the desk.
 * It does not exist when sign-in is on or the demo door is off: the real sign-in is the only way in then.
 */
export async function POST(req: NextRequest) {
  if (!demoLoginOn(process.env)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const form = await req.formData().catch(() => null);
  // Which way of using the desk: an admin, a dispatcher, the billing office or a viewer. Anything else is the admin, as the single demo button always was.
  const asKey = typeof form?.get("as") === "string" ? (form!.get("as") as string) : "admin";
  const user = DEMO_USERS.find((u) => u.key === asKey) ?? DEMO_USERS[0]!;
  // A page the person was on goes back to it; otherwise each lands where that job starts.
  const asked = typeof form?.get("next") === "string" ? (form!.get("next") as string) : "";
  const next = asked !== "" && asked !== "/loads" ? safeNext(asked, user.landing) : user.landing;
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(DEMO_COOKIE, user.key, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: DEMO_TTL_SECONDS });
  // The desk reads its times on the carrier's clock: it is set here so the first page already has it.
  res.cookies.set(ZONE_COOKIE, await workspaceTimezone(currentWorkspaceId()), { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}
