import { NextResponse } from "next/server";
import { readRadarParams } from "@/lib/radar-points";
import { guardRoute } from "@/server/tl/access";
import { getRadarData } from "@/server/tl/radar";
import { radarList, radarPoints, radarUnit } from "@/server/tl/radar-query";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/**
 * The radar's units as JSON, for the map, its list and its inspector to refresh themselves. One route, three answers:
 *   ?mode=points (the default)  lean points for the map, narrowed by kind, state, words, or a radius around a typed place (?near=75201&r=50);
 *   ?mode=list                  a page of rows, nearest first when there is a search, optionally grouped by place (?group=1), narrowed by ?bbox=w,s,e,n or ?ids=a,b;
 *   ?mode=unit&kind=&id=        one unit's full card.
 * Scoped to the workspace and the chosen terminal; anyone who can read may look.
 */
export async function GET(req: Request) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const url = new URL(req.url);
  const get = (k: string) => url.searchParams.get(k);
  const data = await getRadarData(currentWorkspaceId(), await currentTerminal());
  const mode = get("mode") ?? "points";
  const params = readRadarParams(get);
  const body = mode === "list" ? await radarList(data, params) : mode === "unit" ? radarUnit(data, get("kind") ?? "tractor", get("id") ?? "") : await radarPoints(data, params);
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
