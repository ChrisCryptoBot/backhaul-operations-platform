import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { isAuthBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { laneMutationSchema } from "@/contracts/reference";
import { createLane, listLanes, setLaneTarget, softDeleteLane } from "@/server/reference";

async function resolveReferenceRegion(input: {
  requestedRegionId: string | null | undefined;
  bypassAuth: boolean;
}): Promise<string> {
  if (input.requestedRegionId && input.requestedRegionId.trim().length > 0) {
    return input.requestedRegionId.trim();
  }
  if (input.bypassAuth) {
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
    const requestedRegionId = searchParams.get("regionId");
    const regionId = await resolveReferenceRegion({ requestedRegionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "REFERENCE_DATA", action: "READ" });
    }

    const lanes = await listLanes({ regionId });
    return NextResponse.json({ regionId, lanes }, { status: 200 });
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

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const body = laneMutationSchema.parse(await request.json());

    const regionId = await resolveReferenceRegion({ requestedRegionId: body.regionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "REFERENCE_DATA", action: "WRITE" });
    }

    if (body.action === "create_lane") {
      await createLane({ regionId, actorId: actorUserId, ...body.lane });
    } else if (body.action === "set_lane_target") {
      await setLaneTarget({ regionId, actorId: actorUserId, laneId: body.laneId, targetRate: body.targetRate });
    } else if (body.action === "delete_lane") {
      await softDeleteLane({ regionId, actorId: actorUserId, laneId: body.laneId, reason: body.reason });
    }

    const lanes = await listLanes({ regionId });
    return NextResponse.json({ regionId, lanes }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof Error && error.message.includes("already exists")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
