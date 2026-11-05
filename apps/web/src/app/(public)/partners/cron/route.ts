import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runPartnerSync } from "@/server/partners/sync";

/**
 * The partner schedule's heartbeat: ask the connections that are read on a clock (ELD hours, carrier checks) whose time has come. Called every few minutes by whatever runs the desk's cron, with
 * the secret in a header. It does not exist (404) until the server holds the secret, and a wrong secret is a plain 401 with no detail. The answer is counts, never a name, an id or a key.
 */
export const dynamic = "force-dynamic";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function POST(req: NextRequest) {
  const secret = process.env.PARTNER_CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  if (!same(req.headers.get("x-partner-cron") ?? "", secret)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 401 });
  return NextResponse.json({ ok: true, ran: await runPartnerSync() });
}
