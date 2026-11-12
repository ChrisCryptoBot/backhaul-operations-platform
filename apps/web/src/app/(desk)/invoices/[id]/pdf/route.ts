import { guardRoute } from "@/server/tl/access";
import { invoicePdf } from "@/server/tl/invoice-pdf";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

/** GET /invoices/<load id>/pdf : the invoice as a PDF file (docs/MONEY_PLAN.md, rule H), made on the server. Anyone who can read the invoice sheet can download it. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const out = await invoicePdf(params.id, undefined, await currentTerminal());
  if (!out) return new Response("That load has no invoice.", { status: 404 });
  return new Response(Buffer.from(out.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${out.filename}"`,
      "cache-control": "no-store"
    }
  });
}
