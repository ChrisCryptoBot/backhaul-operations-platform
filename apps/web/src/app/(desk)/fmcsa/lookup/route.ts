import { NextResponse } from "next/server";
import { lookupMc } from "@/server/fmcsa/lookup";

export const dynamic = "force-dynamic";

/**
 * A customer's MC number checked at FMCSA: GET /fmcsa/lookup?mc=123456. A route handler (not a server action) so a slow answer never holds up
 * anything else on the screen, and the web key stays on the server. Nothing is stored. A shipper or direct customer has no MC and never
 * calls this: the screens only ask when an MC was typed.
 */
export async function GET(request: Request) {
  const mc = new URL(request.url).searchParams.get("mc") ?? "";
  const result = await lookupMc(mc.slice(0, 40));
  return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=60" } });
}
