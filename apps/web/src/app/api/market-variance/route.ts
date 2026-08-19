import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { listMarketVariance, logMarketVariance } from "@/server/dat/variance-log";

// The persisted market-variance tracker: GET the log + weekly rollups, POST a new
// logged negotiation. Mirrors the Excel Market Variance tab, but the market snapshot
// is captured server-side from the live/cached DAT quote.
const logSchema = z.object({
  regionId: z.string().min(1).optional(),
  originCity: z.string().min(1).max(80),
  originState: z.string().min(2).max(20),
  destCity: z.string().min(1).max(80),
  destState: z.string().min(2).max(20),
  equipment: z.enum(["VAN", "REEFER", "FLATBED"]),
  rateType: z.enum(["SPOT", "CONTRACT"]),
  negotiatedTotal: z.number().positive().max(1_000_000),
  marketTotal: z.number().positive().max(1_000_000),
  miles: z.number().positive().max(20_000).optional(),
  milesSource: z.enum(["dat", "google", "manual"]).optional(),
  loadId: z.string().optional().nullable(),
  brokerId: z.string().optional().nullable(),
  directCustomerId: z.string().optional().nullable(),
  quoteId: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable()
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

export async function GET(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const { searchParams } = new URL(request.url);
    const regionId = await resolveRegion(searchParams.get("regionId"), bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "READ" });
    }

    const view = await listMarketVariance(regionId);
    return NextResponse.json(view, { status: 200 });
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to load market variance log." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const body = logSchema.parse(await request.json());

    const regionId = await resolveRegion(body.regionId, bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "WRITE" });
    }

    const entry = await logMarketVariance({
      regionId,
      actorId: actorUserId,
      originCity: body.originCity,
      originState: body.originState,
      destCity: body.destCity,
      destState: body.destState,
      equipment: body.equipment,
      rateType: body.rateType,
      negotiatedTotal: body.negotiatedTotal,
      marketTotal: body.marketTotal,
      miles: body.miles,
      milesSource: body.milesSource,
      loadId: body.loadId ?? null,
      brokerId: body.brokerId ?? null,
      directCustomerId: body.directCustomerId ?? null,
      quoteId: body.quoteId ?? null,
      notes: body.notes ?? null
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Unable to log market variance." }, { status: 500 });
  }
}
