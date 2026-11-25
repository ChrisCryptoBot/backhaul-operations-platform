import { guardRoute } from "@/server/tl/access";
import { buildPacket } from "@/server/partners/factoring-packet";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

/** GET /invoices/<load id>/packet[?invoiceId=<supplemental id>] : the packet for the invoice (invoice PDF, then each load's rate confirmation, proof of delivery, and lumper receipts) as one PDF. For those who bill. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("bill");
  if (denied) return denied;
  const invoiceId = new URL(req.url).searchParams.get("invoiceId") || undefined;
  const out = await buildPacket(params.id, undefined, await currentTerminal(), { invoiceId });
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
