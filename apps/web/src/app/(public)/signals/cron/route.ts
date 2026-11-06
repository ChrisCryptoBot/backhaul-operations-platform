import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runSignalsCron } from "@/server/tl/signals-cron";

/**
 * The signals schedule's heartbeat (docs/SIGNALS.md): keep every desk's signals up to date, tell people about what is due, and send the weekly report when its hour has come. Called every few minutes by
 * whatever runs the clock (n8n's Schedule trigger, or the host's cron later), with the secret in a header. It does not exist (404) until the server holds the secret, and a wrong secret is a plain 401
 * with no detail. The answer is counts, never a name, an id, an address or a key.
 */
export const dynamic = "force-dynamic";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The desk's own address for the links in a message, when the server was not told one: the one the request came in on. */
function originOf(req: NextRequest): string | null {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return null;
  return `${req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}`;
}

export async function POST(req: NextRequest) {
  const secret = process.env.SIGNALS_CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  if (!same(req.headers.get("x-signals-cron") ?? "", secret)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 401 });
  const counts = await runSignalsCron({ deskUrl: originOf(req) });
  return NextResponse.json({ ok: true, ...counts });
}
