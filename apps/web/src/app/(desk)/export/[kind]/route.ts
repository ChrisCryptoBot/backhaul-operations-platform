import { buildExport } from "@/server/tl/exports";

export const dynamic = "force-dynamic";

/** GET /export/<kind>?<the same filters as the screen> : a CSV download. Kinds: loads, invoices, kpi-drivers, kpi-lanes, kpi-weeks. */
export async function GET(req: Request, { params }: { params: { kind: string } }) {
  const out = await buildExport(params.kind, Object.fromEntries(new URL(req.url).searchParams.entries()));
  if (!out) return new Response("There is no export by that name.", { status: 404 });
  return new Response(out.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${out.filename}"`,
      "cache-control": "no-store"
    }
  });
}
