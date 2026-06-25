import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { getKpiDashboard } from "@/server/kpi-dashboard";
import { buildKpiPdfLikeReport } from "@/server/kpi-reporting";
import { writeKpiGovernanceEvent } from "@/server/kpi-governance";
import { policyAdapter } from "@/domain/policy/policy-adapter";

const schema = z.object({
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  regionId: z.string().optional(),
  comparisonMode: z.enum(["wow", "rolling4", "qtd"]).optional(),
  weeks: z.coerce.number().int().min(4).max(52).optional(),
  lane: z.string().optional(),
  broker: z.string().optional(),
  lot: z.string().optional(),
  severity: z.enum(["INFO", "WARN", "ACTION_REQUIRED"]).optional()
});

export async function GET(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorId = userId ?? "dev-bypass-user";
    const params = new URL(request.url).searchParams;
    const parsed = schema.parse({
      weekIso: params.get("weekIso"),
      regionId: params.get("regionId") ?? undefined,
      comparisonMode: params.get("comparisonMode") ?? undefined,
      weeks: params.get("weeks") ?? undefined,
      lane: params.get("lane") ?? undefined,
      broker: params.get("broker") ?? undefined,
      lot: params.get("lot") ?? undefined,
      severity: params.get("severity") ?? undefined
    });
    let regionId = parsed.regionId ?? "dev-region";
    if (!bypassAuth || !parsed.regionId) {
      regionId = await resolvePhase1RegionId();
    }
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorId, regionId);
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "READ" });
    }
    const payload = await getKpiDashboard({
      regionId,
      weekIso: parsed.weekIso,
      comparisonMode: parsed.comparisonMode,
      weeks: parsed.weeks,
      filters: {
        lane: parsed.lane,
        broker: parsed.broker,
        lot: parsed.lot,
        severity: parsed.severity
      }
    });
    const report = buildKpiPdfLikeReport(payload);
    await writeKpiGovernanceEvent({
      regionId,
      actorId,
      action: "EXPORT_PDF",
      entityId: `kpi:${parsed.weekIso}`,
      afterValue: { weekIso: parsed.weekIso }
    });
    return new NextResponse(report, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="kpi-${parsed.weekIso}.txt"`
      }
    });
  } catch {
    return NextResponse.json({ error: "Failed to export PDF" }, { status: 500 });
  }
}
