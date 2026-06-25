import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { resolvePhase1RegionId } from "@/lib/scope";
import { isAuthBypassed } from "@/lib/auth-mode";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { getLoadDetail } from "@/server/board-detail";
import { policyAdapter } from "@/domain/policy/policy-adapter";

interface Params {
  params: { loadId: string };
}

async function resolveLoadRegion(request: Request, bypassAuth: boolean): Promise<string> {
  const requested = new URL(request.url).searchParams.get("regionId");
  if (requested && requested.trim().length > 0) {
    return requested.trim();
  }
  if (bypassAuth) {
    try {
      return await resolvePhase1RegionId();
    } catch {
      return "dev-region";
    }
  }
  return resolvePhase1RegionId();
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";

    const regionId = await resolveLoadRegion(request, bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "BOARD", action: "READ" });
    }

    let payload = await getLoadDetail({
      regionId,
      loadId: params.loadId
    });
    if (!payload) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 });
    }
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
