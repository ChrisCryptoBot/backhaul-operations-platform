import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { isAuthBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { brokerMutationSchema } from "@/contracts/reference";
import {
  addBrokerRep,
  createBroker,
  listBrokers,
  softDeleteBroker,
  softDeleteBrokerRep,
  updateBroker,
  updateBrokerRep
} from "@/server/reference";

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

    const brokers = await listBrokers({ regionId });
    return NextResponse.json({ regionId, brokers }, { status: 200 });
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
    const body = brokerMutationSchema.parse(await request.json());

    const regionId = await resolveReferenceRegion({ requestedRegionId: body.regionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "REFERENCE_DATA", action: "WRITE" });
    }

    if (body.action === "create_broker") {
      await createBroker({
        regionId,
        actorId: actorUserId,
        name: body.broker.name,
        onboardingStatus: body.broker.onboardingStatus,
        fscDefaultApplies: body.broker.fscDefaultApplies
      });
    } else if (body.action === "update_broker") {
      await updateBroker({ regionId, actorId: actorUserId, brokerId: body.brokerId, fields: body.fields });
    } else if (body.action === "delete_broker") {
      await softDeleteBroker({ regionId, actorId: actorUserId, brokerId: body.brokerId, reason: body.reason });
    } else if (body.action === "add_rep") {
      await addBrokerRep({
        regionId,
        actorId: actorUserId,
        brokerId: body.brokerId,
        name: body.rep.name,
        email: body.rep.email,
        phone: body.rep.phone
      });
    } else if (body.action === "update_rep") {
      await updateBrokerRep({
        regionId,
        actorId: actorUserId,
        brokerId: body.brokerId,
        repId: body.repId,
        fields: body.fields
      });
    } else if (body.action === "delete_rep") {
      await softDeleteBrokerRep({ regionId, actorId: actorUserId, brokerId: body.brokerId, repId: body.repId });
    }

    const brokers = await listBrokers({ regionId });
    return NextResponse.json({ regionId, brokers }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
