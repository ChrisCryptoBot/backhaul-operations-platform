import { NextResponse } from "next/server";
import { guardRoute } from "@/server/tl/access";
import { getRadarData } from "@/server/tl/radar";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/** The radar's units as JSON, for the map to refresh itself. The same data the page renders, scoped to the workspace and the chosen terminal; anyone who can read may look. */
export async function GET() {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const data = await getRadarData(currentWorkspaceId(), await currentTerminal());
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
