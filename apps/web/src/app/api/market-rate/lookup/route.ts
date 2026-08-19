import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { getLaneMarketRate } from "@/server/dat/market-rate";

// Live DAT lane-rate lookup (served from cache when fresh). Powers the negotiation
// widget + copilot. A lookup hits an external, billable API, so it requires the same
// KPI_DASHBOARD read grant as the rest of the analytics surface.
const lookupSchema = z.object({
  regionId: z.string().min(1).optional(),
  originCity: z.string().min(1).max(80),
  originState: z.string().min(2).max(20),
  destCity: z.string().min(1).max(80),
  destState: z.string().min(2).max(20),
  equipment: z.enum(["VAN", "REEFER", "FLATBED"]),
  rateType: z.enum(["SPOT", "CONTRACT"]),
  forceRefresh: z.boolean().optional()
});

async function resolveRegion(requested: string | null | undefined, bypassAuth: boolean): Promise<string> {
  if (requested && requested.trim().length > 0) return requested.trim();
  if (bypassAuth) {
    try {
      return await resolvePhase1RegionId();
    } catch {
      return "dev-region";
    }
  }
  return resolvePhase1RegionId();
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const body = lookupSchema.parse(await request.json());

    const regionId = await resolveRegion(body.regionId, bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "READ" });
    }

    const quote = await getLaneMarketRate(
      regionId,
      {
        originCity: body.originCity,
        originState: body.originState,
        destCity: body.destCity,
        destState: body.destState,
        equipment: body.equipment,
        rateType: body.rateType
      },
      { forceRefresh: body.forceRefresh }
    );

    return NextResponse.json({ quote }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to fetch market rate right now." }, { status: 502 });
  }
}
