import { prisma } from "@/lib/db";
import { isAllowedMime } from "@/lib/attachments";
import { guardRoute } from "@/server/tl/access";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * A document on a load, handed back only to someone in the workspace it belongs to. Pictures open in the page; everything else is saved, never opened inside the desk. The type
 * is what was checked when the file was kept, never what the request says, and the response forbids the browser to guess another.
 */
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("viewer");
  if (denied) return denied;
  if (!ID.test(params.id)) return new Response("Not found", { status: 404 });
  const doc = await prisma.loadDocument.findFirst({ where: { id: params.id, workspaceId: currentWorkspaceId() }, select: { name: true, mime: true, storageKey: true } });
  if (!doc || !isAllowedMime(doc.mime)) return new Response("Not found", { status: 404 });
  const bytes = await readFile(doc.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  const ascii = doc.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const inline = doc.mime.startsWith("image/");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, no-store"
    }
  });
}
