import { serveRead } from "@/server/api/handler";

/** GET /api/v1/loads: the partner read API (src/server/api/handler.ts). A key with the "loads" scope; no cookie or session is read. */
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return serveRead(req, "loads");
}
