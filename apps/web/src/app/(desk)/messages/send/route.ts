import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { ATTACHMENTS_PER_MESSAGE, ATTACHMENT_MAX_BYTES, checkAttachment } from "@/lib/attachments";
import { sendMessage, type CheckedFile } from "@/server/tl/messages";

/**
 * Save a message with its pictures and files. A route and not a server action, because a message can carry up to four files of 10 MB and a server action's body
 * is capped at 10 MB in all. Every file is judged before any is kept: one refused file refuses the whole message, so a half-sent message never exists.
 * Nothing is carried to a driver's phone (see Message.deliveredAt).
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
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
  const picked = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size >= 0);
  if (picked.length > ATTACHMENTS_PER_MESSAGE) return NextResponse.json({ ok: false, error: `A message can carry up to ${ATTACHMENTS_PER_MESSAGE} files.` }, { status: 400 });

  const files: CheckedFile[] = [];
  const problems: string[] = [];
  for (const f of picked) {
    if (f.size > ATTACHMENT_MAX_BYTES) {
      problems.push(`${f.name}: That file is over ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`);
      continue;
    }
    const checked = checkAttachment(f.name, f.type, new Uint8Array(await f.arrayBuffer()));
    if (checked.ok) files.push(checked);
    else problems.push(checked.error);
  }
  if (problems.length > 0) return NextResponse.json({ ok: false, error: problems.join(" ") }, { status: 400 });

  const out = await sendMessage({ driverId: text("driverId"), body: text("body"), loadId: text("loadId") || null, clientId: text("clientId") || null, files });
  if (!out.ok) return NextResponse.json(out, { status: 400 });
  revalidatePath("/messages");
  return NextResponse.json(out);
}
