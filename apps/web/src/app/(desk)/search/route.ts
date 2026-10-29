import { searchDesk } from "@/server/tl/search";

export const dynamic = "force-dynamic";

/** GET /search?q=... : the header search's results. Read-only. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ hits: await searchDesk(q) });
}
