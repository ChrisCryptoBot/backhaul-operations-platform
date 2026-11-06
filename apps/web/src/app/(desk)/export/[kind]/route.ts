import { buildExport } from "@/server/tl/exports";
import { guardRoute } from "@/server/tl/access";

export const dynamic = "force-dynamic";

/** GET /export/<kind>?<the same filters as the screen> : a CSV download. Kinds: loads, invoices, kpi-drivers, kpi-lanes, kpi-weeks, and the Leak Ledger's leaks, leaks-weeks and leaks-items. */
export async function GET(req: Request, { params }: { params: { kind: string } }) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  // The Leak Ledger prices mistakes in dollars, so its files are the billing office's, like its screen.
  if (params.kind.startsWith("leaks")) {
    const noBill = await guardRoute("bill");
    if (noBill) return noBill;
  }
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
