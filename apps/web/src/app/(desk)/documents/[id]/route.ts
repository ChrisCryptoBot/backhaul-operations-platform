import { prisma } from "@/lib/db";
import { isAllowedMime } from "@/lib/attachments";
import { guardRoute } from "@/server/tl/access";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * A document on a load, handed back only to someone in the workspace it belongs to.
 * Images and PDFs open inline inside the desk viewer / modal iframe.
 * Downloads are triggered only when explicitly requested (e.g. ?download=1).
 */
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  if (!ID.test(params.id)) return new Response("Not found", { status: 404 });
  const doc = await prisma.loadDocument.findFirst({
    where: { id: params.id, workspaceId: currentWorkspaceId() },
    select: { name: true, mime: true, storageKey: true }
  });
  if (!doc || !isAllowedMime(doc.mime)) return new Response("Not found", { status: 404 });
  const bytes = await readFile(doc.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });

  const ascii = doc.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");

  // Check if caller explicitly requested a download (e.g. download button)
  const url = new URL(req.url);
  const isExplicitDownload = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

  // PDFs, images, and plain text can render inline in the browser iframe/tab.
  // Files only download when explicitly requested via download action.
  const canDisplayInline = doc.mime.startsWith("image/") || doc.mime === "application/pdf" || doc.mime === "text/plain";
  const inline = !isExplicitDownload && canDisplayInline;

  // For inline PDF rendering in iframes, do not restrict with 'sandbox' which causes browsers to force download
  const csp = doc.mime === "application/pdf"
    ? "default-src 'none'; style-src 'unsafe-inline'; object-src 'self'"
    : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": csp,
      "Cache-Control": "private, no-store"
    }
  });
}
