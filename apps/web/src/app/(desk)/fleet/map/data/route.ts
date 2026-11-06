import { NextResponse } from "next/server";
import { readRadarParams } from "@/lib/radar-points";
import { guardRoute } from "@/server/tl/access";
import { getRadarData } from "@/server/tl/radar";
import { radarList, radarPoints, radarUnit } from "@/server/tl/radar-query";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { getTrailerWhere, getTruckWhere } from "@/server/tl/whereabouts";
import { unitTip } from "@/lib/whereabouts";

export const dynamic = "force-dynamic";

/**
 * The radar's units as JSON, for the map, its list and its inspector to refresh themselves. One route, three answers:
 *   ?mode=points (the default)  lean points for the map, narrowed by kind, state, words, or a radius around a typed place (?near=75201&r=50);
 *   ?mode=list                  a page of rows, nearest first when there is a search, optionally grouped by place (?group=1), narrowed by ?bbox=w,s,e,n or ?ids=a,b;
 *   ?mode=unit&kind=&id=        one unit's full card;
 *   ?mode=where&kind=&id=       the hover tooltip for one unit: where it is, in words, and what it is doing (one small read, not the whole fleet).
 * Scoped to the workspace and the chosen terminal; anyone who can read may look.
 */
export async function GET(req: Request) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const url = new URL(req.url);
  const get = (k: string) => url.searchParams.get(k);
  const mode = get("mode") ?? "points";
  if (mode === "where") {
    const id = get("id") ?? "";
    const found = get("kind") === "trailer" ? await getTrailerWhere([id], currentWorkspaceId()) : await getTruckWhere([id], currentWorkspaceId(), await currentTerminal());
    const u = found.get(id);
    return NextResponse.json(u ? unitTip(u) : { title: "Not found" }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const data = await getRadarData(currentWorkspaceId(), await currentTerminal());
  const params = readRadarParams(get);
  const body = mode === "list" ? await radarList(data, params) : mode === "unit" ? radarUnit(data, get("kind") ?? "tractor", get("id") ?? "") : await radarPoints(data, params);
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
