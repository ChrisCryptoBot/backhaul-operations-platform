import { guardRoute } from "@/server/tl/access";
import { buildPacket } from "@/server/partners/factoring-packet";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

/** GET /invoices/<load id>/packet : the factoring packet for the invoice (the invoice, then each load's rate confirmation and proof of delivery) as one PDF. For those who bill. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("bill");
  if (denied) return denied;
  const out = await buildPacket(params.id, undefined, await currentTerminal());
  if (!out.ok) return new Response(out.error, { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(Buffer.from(out.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${out.filename}"`,
      "cache-control": "no-store",
      "x-packet-pages": String(out.pages)
    }
  });
}
