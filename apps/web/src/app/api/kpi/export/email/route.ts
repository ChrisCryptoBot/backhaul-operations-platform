import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { getKpiDashboard } from "@/server/kpi-dashboard";
import { buildKpiEmailSummary } from "@/server/kpi-reporting";
import { writeKpiGovernanceEvent } from "@/server/kpi-governance";
import { policyAdapter } from "@/domain/policy/policy-adapter";

const bodySchema = z.object({
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  regionId: z.string().optional(),
  recipients: z.array(z.string().email()).min(1).max(20),
  comparisonMode: z.enum(["wow", "rolling4", "qtd"]).optional(),
  weeks: z.coerce.number().int().min(4).max(52).optional(),
  lane: z.string().optional(),
  broker: z.string().optional(),
  lot: z.string().optional(),
  severity: z.enum(["INFO", "WARN", "ACTION_REQUIRED"]).optional()
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
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "READ" });
    }
    const payload = await getKpiDashboard({
      regionId,
      weekIso: body.weekIso,
      comparisonMode: body.comparisonMode,
      weeks: body.weeks,
      filters: {
        lane: body.lane,
        broker: body.broker,
        lot: body.lot,
        severity: body.severity
      }
    });
    const summary = buildKpiEmailSummary(payload);
    await writeKpiGovernanceEvent({
      regionId,
      actorId,
      action: "EMAIL_SUMMARY",
      entityId: `kpi:${body.weekIso}`,
      afterValue: { recipients: body.recipients, subject: summary.subject }
    });
    return NextResponse.json(
      {
        queued: true,
        recipients: body.recipients,
        subject: summary.subject,
        preview: summary.body
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json({ error: "Failed to queue KPI summary email" }, { status: 500 });
  }
}
