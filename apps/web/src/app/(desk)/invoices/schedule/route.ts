import { guardRoute } from "@/server/tl/access";
import { scheduleCsvFor } from "@/server/partners/factoring-schedule";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

/**
 * GET /invoices/schedule : the schedule of accounts as a CSV, one row per open invoice that is not with a factor (docs/MONEY_PLAN.md, Wave 2). `?loads=a,b` narrows it to the invoices
 * those loads are on. For those who bill.
 */
export async function GET(req: Request) {
  const denied = await guardRoute("bill");
  if (denied) return denied;
  const asked = new URL(req.url).searchParams.get("loads");
  const only = asked ? asked.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,40}$/.test(s)).slice(0, 200) : null;
  const out = await scheduleCsvFor(undefined, await currentTerminal(), only && only.length > 0 ? only : null);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(out.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="schedule-of-accounts-${day}.csv"`,
      "cache-control": "no-store",
      ...(out.cut ? { "x-schedule-cut": "true" } : {})
    }
  });
}
