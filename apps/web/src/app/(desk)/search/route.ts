import { searchDesk } from "@/server/tl/search";
import { guardRoute } from "@/server/tl/access";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/** GET /search?q=... : the header search's results. Read-only. */
export async function GET(req: Request) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ hits: await searchDesk(q, currentWorkspaceId(), await currentTerminal()) });
}
