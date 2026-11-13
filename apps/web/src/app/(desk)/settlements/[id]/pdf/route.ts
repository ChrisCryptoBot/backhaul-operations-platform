import { guardRoute } from "@/server/tl/access";
import { statementPdf } from "@/server/tl/statement-pdf";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

/**
 * GET /settlements/<id>/pdf : the driver's pay statement as a PDF (docs/MONEY_PLAN.md, Wave 4 step 6), made on the server. The same gate as the statement page: anyone who may read the desk,
 * inside their terminals (a statement outside them is a 404, as the page is). A draft downloads stamped DRAFT and a voided one VOID, on every page and in the file's name.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const out = await statementPdf(params.id, undefined, await currentTerminal());
  if (!out) return new Response("There is no statement by that id.", { status: 404 });
  return new Response(Buffer.from(out.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${out.filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    }
  });
}
