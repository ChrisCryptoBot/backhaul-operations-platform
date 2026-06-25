import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { acknowledgeKpiAlert } from "@/server/kpi-alerts";
import { writeKpiGovernanceEvent } from "@/server/kpi-governance";
import { policyAdapter } from "@/domain/policy/policy-adapter";

const bodySchema = z.object({
  alertId: z.string().min(1),
  reason: z.string().max(250).optional(),
  regionId: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorId = userId ?? "dev-bypass-user";
    const body = bodySchema.parse(await request.json());
    let regionId = body.regionId ?? "dev-region";
    if (!bypassAuth || !body.regionId) {
      regionId = await resolvePhase1RegionId();
    }
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorId, regionId);
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "WRITE" });
    }
    await acknowledgeKpiAlert({
      alertId: body.alertId,
      actorId,
      reason: body.reason
    });
    await writeKpiGovernanceEvent({
      regionId,
      actorId,
      action: "ACK_ALERT",
      entityId: body.alertId,
      reason: body.reason
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Failed to acknowledge alert" }, { status: 500 });
  }
}
