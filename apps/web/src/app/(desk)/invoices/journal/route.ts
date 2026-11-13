import { guardRoute } from "@/server/tl/access";
import { journalFile } from "@/server/partners/accounting";

export const dynamic = "force-dynamic";

/**
 * GET /invoices/journal?from=YYYY-MM-DD&to=YYYY-MM-DD: the double-entry journal as a CSV (docs/MONEY_PLAN.md, Wave 3), for any accounting system that is not QuickBooks. The billing office's.
 * Refused with why (409, plain text) while a record cannot be booked or a kind it uses has no account: the screen checks first, so a person sees the reasons there.
 */
export async function GET(req: Request) {
  const denied = await guardRoute("bill");
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const out = await journalFile({ from: q.get("from"), to: q.get("to") });
  if (!out.ok) return new Response([out.error, ...out.problems].join("\n"), { status: 409, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(out.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store" } });
}
