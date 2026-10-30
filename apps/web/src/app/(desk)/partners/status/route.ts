import { NextResponse } from "next/server";
import { partnerStatus } from "@/server/partners/connections";
import { guardRoute } from "@/server/tl/access";

export const dynamic = "force-dynamic";

/**
 * GET /partners/status: for each company TrueLane could connect, whether the server has its keys and whether this fleet has connected it. Booleans and names of companies only:
 * no key, no key's name, no account detail.
 */
export async function GET() {
  const denied = await guardRoute("viewer");
  if (denied) return denied;
  const rows = await partnerStatus();
  return NextResponse.json({ partners: rows.map((r) => ({ capability: r.capability, provider: r.provider, configured: r.configured, connected: r.connected })) }, { headers: { "Cache-Control": "private, no-store" } });
}
