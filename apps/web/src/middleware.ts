import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { decide } from "@/lib/auth-route";
import { DEMO_COOKIE, demoDecide, demoLoginOn } from "@/lib/demo-session";
import { SESSION_COOKIE, peekSession } from "@/lib/session-cookie";

/**
 * The front door. With DESK_AUTH off (the default) this does nothing: the desk is the demo's and every request goes straight through. With it on, a visitor who is not signed in
 * goes to the sign-in page (a fetch gets a 401), and one who is signed in but has no desk session yet is sent to make one. What it decides is in src/lib/auth-route.ts. It
 * trusts nothing: whether a person may be on a desk, and as what, is asked of the member table by every page, action and route.
 */
const handler = clerkMiddleware((auth, req) => {
  const door = decide({
    path: req.nextUrl.pathname,
    method: req.method,
    userId: auth().userId,
    hasSession: peekSession(req.cookies.get(SESSION_COOKIE)?.value, Date.now()) != null,
    wantsHtml: (req.headers.get("accept") ?? "").includes("text/html"),
    search: req.nextUrl.search
  });
  switch (door.kind) {
    case "sign_in":
      return NextResponse.redirect(new URL("/sign-in", req.url));
    case "enter":
      return NextResponse.redirect(new URL(`/auth/enter?next=${encodeURIComponent(door.next)}`, req.url));
    case "unauthorized":
      return NextResponse.json({ ok: false, error: "Sign in to use the desk." }, { status: 401 });
    default:
      return NextResponse.next();
  }
});

export default function middleware(req: NextRequest, evt: NextFetchEvent) {
  if (process.env.DESK_AUTH !== "on") {
    if (!demoLoginOn(process.env)) return NextResponse.next();
    // The demo door: no accounts, but a sign-in page and a Sign out (src/lib/demo-session.ts).
    const door = demoDecide({ path: req.nextUrl.pathname, method: req.method, hasDemo: req.cookies.get(DEMO_COOKIE)?.value === "1", wantsHtml: (req.headers.get("accept") ?? "").includes("text/html") });
    if (door.kind === "sign_in") return NextResponse.redirect(new URL("/sign-in", req.url));
    if (door.kind === "unauthorized") return NextResponse.json({ ok: false, error: "Sign in to use the desk." }, { status: 401 });
    return NextResponse.next();
  }
  return handler(req, evt);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)"] };
