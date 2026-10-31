import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { ATTACHMENT_MAX_BYTES, checkAttachment } from "@/lib/attachments";
import { guardRoute } from "@/server/tl/access";
import { addLoadDocument } from "@/server/tl/documents";
import { currentActor } from "@/server/tl/identity";

/**
 * Keep a file on a load. A route and not a server action because a file can be 10 MB and a server action's body is capped at 10 MB in all. The file is judged by its own bytes
 * (its real type, its size, a picture's location removed) before anything is kept.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await guardRoute("dispatcher");
  if (denied) return denied;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "That could not be read. Try again." }, { status: 400 });
  }
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const file = form.get("file");
  if (typeof file === "string" || !file || file.size === 0) return NextResponse.json({ ok: false, error: "Choose a file." }, { status: 400 });
  if (file.size > ATTACHMENT_MAX_BYTES) return NextResponse.json({ ok: false, error: `That file is over ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.` }, { status: 400 });
  const checked = checkAttachment(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  const out = await addLoadDocument(text("loadId"), text("kind"), checked, new Date(), undefined, currentActor(), text("stopId") || null);
  if (!out.ok) return NextResponse.json(out, { status: 400 });
  revalidatePath("/loads");
  revalidatePath("/invoices");
  return NextResponse.json(out);
}
