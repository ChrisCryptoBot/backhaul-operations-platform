import { NextResponse } from "next/server";
import { isOAuthProvider } from "@/lib/oauth";
import { checkAccess, guardRoute } from "@/server/tl/access";
import { completeOAuth } from "@/server/partners/oauth";
import { originOf } from "@/server/partners/origin";

export const dynamic = "force-dynamic";

/**
 * GET /partners/oauth/{provider}/callback: where a partner company's sign-in sends the person back (docs/MONEY_PLAN.md, Wave 3). Admin only, like every connection. The state must be one
 * this fleet started and has not used; the code is traded for tokens on the server. The person lands on Settings, Integrations, with whether it worked and, if not, why in plain words.
 * No token, code or state is ever put in the address it sends them to.
 */
export async function GET(req: Request, { params }: { params: { provider: string } }) {
  const denied = await guardRoute("admin");
  if (denied) return denied;
  const access = await checkAccess("admin");
  const provider = String(params.provider);
  const origin = originOf(req.headers);
  const back = new URL("/settings", origin ?? req.url);
  back.searchParams.set("tab", "integrations");
  back.searchParams.set("signin", provider);
  if (!isOAuthProvider(provider) || !origin) {
    back.searchParams.set("result", "failed");
    back.searchParams.set("why", "That sign-in address is not one this desk knows.");
    return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store" } });
  }
  const q = new URL(req.url).searchParams;
  const out = await completeOAuth(
    provider,
    { state: q.get("state"), code: q.get("code"), accountId: q.get("realmId"), error: q.get("error") },
    { origin, who: access.ok ? (access.identity.name ?? access.identity.email) : null }
  );
  back.searchParams.set("result", out.ok ? "ok" : "failed");
  if (!out.ok) back.searchParams.set("why", out.error.slice(0, 200));
  return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store" } });
}
