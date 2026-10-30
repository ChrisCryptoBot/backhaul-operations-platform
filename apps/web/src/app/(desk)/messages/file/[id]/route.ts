import { prisma } from "@/lib/db";
import { isAllowedMime } from "@/lib/attachments";
import { readFile } from "@/server/tl/message-files";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * A message's picture or file, handed back only to someone in the workspace it belongs to. Pictures are shown in the message; everything else is saved, never opened
 * inside the desk. The type comes from what was checked when the file was kept, never from the request, and the response forbids the browser to guess another.
 */
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  if (!ID.test(params.id)) return new Response("Not found", { status: 404 });
  const att = await prisma.messageAttachment.findFirst({
    where: { id: params.id, message: { thread: { workspaceId: currentWorkspaceId() } } },
    select: { kind: true, name: true, mime: true, storageKey: true }
  });
  if (!att || !isAllowedMime(att.mime)) return new Response("Not found", { status: 404 });
  const bytes = await readFile(att.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });

  const name = (att.name ?? "file").replace(/["\\\r\n]/g, "_");
  const inline = att.kind === "image";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(att.name ?? "file")}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, no-store"
    }
  });
}
