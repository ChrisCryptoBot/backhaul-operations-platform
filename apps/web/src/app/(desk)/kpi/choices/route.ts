import { NextResponse } from "next/server";
import { asKpiPeriod } from "@/lib/kpi-periods";
import { guardRoute } from "@/server/tl/access";
import { kpiChoices, type KpiChoiceField } from "@/server/tl/kpi-choices";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

const FIELDS: readonly KpiChoiceField[] = ["lane", "broker", "driver", "truck"];

/** The names a KPI filter box offers as you type: GET /kpi/choices?f=lane&q=dal&period=4w. For the terminals in view, a few at a time. */
export async function GET(request: Request) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const f = params.get("f") as KpiChoiceField;
  if (!FIELDS.includes(f)) return NextResponse.json({ choices: [] }, { status: 400 });
  const choices = await kpiChoices(f, params.get("q") ?? "", asKpiPeriod(params.get("period") ?? undefined), await currentTerminal());
  return NextResponse.json({ choices }, { headers: { "Cache-Control": "private, no-store" } });
}
