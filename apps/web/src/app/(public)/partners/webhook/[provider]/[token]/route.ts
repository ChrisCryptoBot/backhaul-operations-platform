import { NextResponse, type NextRequest } from "next/server";
import { handleWebhook } from "@/server/partners/webhook";
import { signatureHeaderFor } from "@/server/partners/webhook-core";

/**
 * POST /partners/webhook/<company>/<token>: a company's event for one fleet. Open to a signed-out caller on purpose: the signature on the body is the credential, not a session. The work is
 * in server/partners/webhook.ts (token, signature on the raw bytes, one record per event id, applied through the same rules a person's hand uses).
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { provider: string; token: string } }) {
  const len = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(len) && len > 256 * 1024) return NextResponse.json({ ok: false, error: "Too large." }, { status: 413 });
  const raw = await req.text();
  const out = await handleWebhook({ provider: params.provider, token: params.token, raw, signature: req.headers.get(signatureHeaderFor(params.provider)) });
  return NextResponse.json(out.body, { status: out.status });
}
