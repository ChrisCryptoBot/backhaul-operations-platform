import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { isAuthBypassed } from "@/lib/auth-mode";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { getKpiDashboard } from "@/server/kpi-dashboard";
import { kpiDashboardSchema } from "@/contracts/kpi";
import { policyAdapter } from "@/domain/policy/policy-adapter";

const schema = z.object({
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  comparisonMode: z.enum(["wow", "rolling4", "qtd"]).optional(),
  weeks: z.coerce.number().int().min(4).max(52).optional(),
  lane: z.string().optional(),
  broker: z.string().optional(),
  lot: z.string().optional(),
  severity: z.enum(["INFO", "WARN", "ACTION_REQUIRED"]).optional(),
  regionId: z.string().optional()
});

export async function GET(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";

    const params = new URL(request.url).searchParams;
    const parsedQuery = schema.parse({
      weekIso: params.get("weekIso"),
      comparisonMode: params.get("comparisonMode") ?? undefined,
      weeks: params.get("weeks") ?? undefined,
      lane: params.get("lane") ?? undefined,
      broker: params.get("broker") ?? undefined,
      lot: params.get("lot") ?? undefined,
      severity: params.get("severity") ?? undefined,
      regionId: params.get("regionId") ?? undefined
    });

    let regionId = parsedQuery.regionId ?? "dev-region";
    try {
      if (!bypassAuth || !parsedQuery.regionId) {
        regionId = await resolvePhase1RegionId();
      }
      if (!bypassAuth) {
        const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
        policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "READ" });
      }
    } catch (error) {
      if (!bypassAuth) {
        throw error;
      }
    }

    const payload = await getKpiDashboard({
      regionId,
      weekIso: parsedQuery.weekIso,
      comparisonMode: parsedQuery.comparisonMode,
      weeks: parsedQuery.weeks,
      filters: {
        lane: parsedQuery.lane,
        broker: parsedQuery.broker,
        lot: parsedQuery.lot,
        severity: parsedQuery.severity
      }
    });
    const contractPayload = kpiDashboardSchema.safeParse(payload);
    if (!contractPayload.success) {
      return NextResponse.json({ error: "KPI payload contract mismatch" }, { status: 500 });
    }
    return NextResponse.json(contractPayload.data, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid query params", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
