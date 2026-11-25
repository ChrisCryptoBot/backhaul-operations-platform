import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { resealCredentials } from "@/server/partners/credentials";
import { purgeOldDeliveries, purgeOldEvents, purgeOldPings, purgeOldStays } from "@/server/partners/retention";
import { runPartnerSync } from "@/server/partners/sync";
import { pollPayrollStatus } from "@/server/partners/payroll";
import { freezeRecentDeliveries } from "@/server/tl/detention-evidence";
import { deliverDue } from "@/server/webhooks/deliver";

/**
 * The partner schedule's heartbeat: ask the connections that are read on a clock (ELD hours, carrier checks) whose time has come. Called every few minutes by whatever runs the desk's cron, with
 * the secret in a header. It does not exist (404) until the server holds the secret, and a wrong secret is a plain 401 with no detail. The answer is counts, never a name, an id or a key.
 */
export const dynamic = "force-dynamic";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function POST(req: NextRequest) {
  const secret = process.env.PARTNER_CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  if (!same(req.headers.get("x-partner-cron") ?? "", secret)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 401 });
  // The same heartbeat does the housekeeping: connections read on a clock, keys sealed under a key that was rotated out, and webhook events past the keeping period. Counts only.
  const ran = await runPartnerSync();
  // Payroll runs sent days ago with no word of clearing: asked where they stand (each at most twice a day), applied exactly as the webhook would be.
  const payroll = await pollPayrollStatus().catch(() => null);
  // The outbound webhook outbox (Wave 7): due deliveries claimed (two runs never take the same row) and sent, each to its one checked address. Counts only.
  const webhooks = await deliverDue().catch(() => null);
  const resealed = await resealCredentials();
  const purged = await purgeOldEvents();
  const deliveriesPurged = await purgeOldDeliveries();
  // Freeze what each recently delivered truck's track says about its stops BEFORE the fixes are deleted: the detention evidence pack (docs/DETENTION_EVIDENCE.md) outlives the week the fixes are kept.
  // If freezing throws or any load failed, hold off purging pings so proof is never lost.
  let frozen: Awaited<ReturnType<typeof freezeRecentDeliveries>> | null = null;
  let freezeThrew = false;
  try {
    frozen = await freezeRecentDeliveries();
  } catch {
    freezeThrew = true;
  }
  const freezeFailed = frozen?.failed ?? 0;
  const pingsHeld = freezeThrew || freezeFailed > 0;
  const pingsPurged = pingsHeld ? "held" : await purgeOldPings();
  const staysPurged = await purgeOldStays();
  return NextResponse.json({
    ok: true,
    ran,
    payroll,
    webhooks,
    resealed,
    purged,
    deliveriesPurged,
    pingsPurged,
    ...(freezeThrew ? { freezeFailed: "error" } : freezeFailed > 0 ? { freezeFailed } : {}),
    staysPurged,
    evidenceFrozen: frozen ? frozen.created + frozen.improved : 0
  });
}
