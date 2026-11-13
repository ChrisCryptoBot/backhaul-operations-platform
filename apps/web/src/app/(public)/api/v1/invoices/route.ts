import { serveRead } from "@/server/api/handler";

/** GET /api/v1/invoices: the partner read API (src/server/api/handler.ts). A key with the "invoices" scope; no cookie or session is read. */
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return serveRead(req, "invoices");
}
