import { NextResponse } from "next/server";
import { measureForDesk } from "@/server/geo/desk";

export const dynamic = "force-dynamic";

/**
 * Measure a quote's route: POST /geo/measure with { stops: [{ address, role }] }. Returns the loaded miles, the drive hours for them, the empty
 * miles in the middle of the route, and for each truck with a base its empty miles to the pickup and home. A route handler (not a server action)
 * so a slow lookup never holds up the live price. Nothing is stored.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "That was not a route." }, { status: 400 });
  }
  const raw = (body as { stops?: Array<{ address?: unknown; role?: unknown }> } | null)?.stops;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10) return NextResponse.json({ ok: false, error: "A route has two to ten stops." }, { status: 400 });
  const stops = raw.map((s) => ({ address: typeof s.address === "string" ? s.address.slice(0, 200) : "", role: s.role === "delivery" ? ("delivery" as const) : ("pickup" as const) }));
  return NextResponse.json(await measureForDesk(stops));
}
