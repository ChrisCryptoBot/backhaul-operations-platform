import { prisma } from "@/lib/db";
import { isAllowedMime } from "@/lib/attachments";
import { terminalFilter } from "@/lib/scope";
import { guardRoute } from "@/server/tl/access";
import { readFile } from "@/server/tl/message-files";
import { currentAllowed } from "@/server/tl/scope";
import { currentWorkspaceId } from "@/server/tl/workspace";

/** The photo of a receipt a driver sent, handed back only to someone who sees driver pay in this workspace, for a driver of a terminal they may see. The type is the one checked when it was kept. */
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("billing_details");
  if (denied) return denied;
  if (!ID.test(params.id)) return new Response("Not found", { status: 404 });
  const limit = await currentAllowed();
  const r = await prisma.driverReceipt.findFirst({
    where: { id: params.id, workspaceId: currentWorkspaceId(), ...(limit == null ? {} : { driver: { terminal: terminalFilter(limit) } }) },
    select: { mime: true, storageKey: true }
  });
  if (!r?.storageKey || !r.mime || !isAllowedMime(r.mime)) return new Response("Not found", { status: 404 });
  const bytes = await readFile(r.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": r.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": 'inline; filename="receipt.jpg"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, no-store"
    }
  });
}
