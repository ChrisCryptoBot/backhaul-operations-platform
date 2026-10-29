import { NextResponse } from "next/server";
import { suggestPlaces } from "@/server/geo/mapbox";

export const dynamic = "force-dynamic";

/**
 * Places for what is being typed in an address box: GET /geo/suggest?q=dal. A route handler rather than a server action so that typing never
 * waits behind the Quote page's pricing action, and so the answer can be cached for the person's next keystroke. Server-side token; nothing is stored.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const places = await suggestPlaces(q.slice(0, 120));
  return NextResponse.json({ places }, { headers: { "Cache-Control": "private, max-age=60" } });
}
