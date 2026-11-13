import { buildExport } from "@/server/tl/exports";
import { guardRoute } from "@/server/tl/access";

export const dynamic = "force-dynamic";

/** GET /export/<kind>?<the same filters as the screen> : a CSV download. Kinds: loads, invoices, kpi-drivers, kpi-lanes, kpi-weeks, and the Leak Ledger's leaks, leaks-weeks and leaks-items. */
export async function GET(req: Request, { params }: { params: { kind: string } }) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  // The Leak Ledger prices mistakes in dollars, so its files are the billing office's, like its screen.
  if (params.kind.startsWith("leaks") || params.kind.startsWith("data-health")) {
    const noBill = await guardRoute("bill");
    if (noBill) return noBill;
  }
  // A quarter's fuel-tax return and its audit file (tax owed, fuel receipts, every mile's backing) are the billing office's, like the work behind them.
  if (params.kind === "ifta" || params.kind === "ifta-audit") {
    const noBill = await guardRoute("bill");
    if (noBill) return noBill;
  }
  // Driver pay statements and their lines are the billing office's, like their screens; so is the 1099 file (legal names, TIN last four, addresses).
  if (params.kind === "contractor-1099" || params.kind === "settlements" || params.kind === "settlement-lines") {
    const noTax = await guardRoute("billing_details");
    if (noTax) return noTax;
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
