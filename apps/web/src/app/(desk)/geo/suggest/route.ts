import { NextResponse } from "next/server";
import { suggestPlaces } from "@/server/geo/mapbox";
import { guardRoute } from "@/server/tl/access";
import { overBudget } from "@/server/tl/budget";

export const dynamic = "force-dynamic";

/**
 * Places for what is being typed in an address box: GET /geo/suggest?q=dal. A route handler rather than a server action so that typing never
 * waits behind the Quote page's pricing action, and so the answer can be cached for the person's next keystroke. Server-side token; nothing is stored.
 */
export async function GET(request: Request) {
  const denied = await guardRoute("dispatch", "billing_details");
  if (denied) return denied;
  const over = overBudget("geo_suggest");
  if (over) return over;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const places = await suggestPlaces(q.slice(0, 120));
  // Only an answer with places is kept for the next keystroke. An empty one (the lookup was refused, timed out, or the allowance was spent for a moment) must never be remembered: the same words would show nothing for a minute.
  return NextResponse.json({ places }, { headers: { "Cache-Control": places.length > 0 ? "private, max-age=60" : "no-store" } });
}
