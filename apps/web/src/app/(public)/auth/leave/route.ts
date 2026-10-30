import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/** The end of signing out: the provider has ended its session, and this removes the desk's own cookie and goes to the sign-in page. Safe for anyone to open. */
export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/sign-in", req.url));
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return res;
}
