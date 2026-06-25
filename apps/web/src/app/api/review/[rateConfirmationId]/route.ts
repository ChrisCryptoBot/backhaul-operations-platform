import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { isAuthBypassed } from "@/lib/auth-mode";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { ReviewConflictError, ReviewNotFoundError, ReviewValidationError } from "@/lib/review-errors";
import {
  approveRateConfirmationReview,
  getRateConfirmationForReview,
  rejectRateConfirmationReview
} from "@/server/review";
import { policyAdapter } from "@/domain/policy/policy-adapter";

interface Params {
  params: { rateConfirmationId: string };
}

const actionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional()
});

async function resolveRegionAndActor() {
  const { userId } = await auth();
  const bypassAuth = isAuthBypassed();
  if (!bypassAuth && !userId) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const actorUserId = userId ?? "dev-bypass-user";
  return { actorUserId };
}

async function resolveRequestedReviewRegion(request: Request, bypassAuth: boolean): Promise<string> {
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
    const context = await resolveRegionAndActor();
    if ("error" in context) {
      return context.error;
    }
    const regionId = await resolveRequestedReviewRegion(request, isAuthBypassed());
    if (!isAuthBypassed()) {
      const access = await policyAdapter.requireRegionAccess(context.actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "RATE_CONFIRMATION_REVIEW", action: "READ" });
    }
    const payload = await getRateConfirmationForReview({
      regionId,
      rateConfirmationId: params.rateConfirmationId
    });
    if (!payload) {
      return NextResponse.json({ error: "Rate confirmation not found" }, { status: 404 });
    }
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const context = await resolveRegionAndActor();
    if ("error" in context) {
      return context.error;
    }
    const bypassAuth = isAuthBypassed();
    const regionId = await resolveRequestedReviewRegion(request, bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(context.actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "RATE_CONFIRMATION_REVIEW", action: "REVIEW" });
    }
    const body = actionSchema.parse(await request.json());
    if (body.action === "approve") {
      const payload = await approveRateConfirmationReview({
        actorId: context.actorUserId,
        regionId,
        rateConfirmationId: params.rateConfirmationId
      });
      return NextResponse.json(payload, { status: payload.alreadyExisted ? 200 : 201 });
    }
    const payload = await rejectRateConfirmationReview({
      actorId: context.actorUserId,
      regionId,
      rateConfirmationId: params.rateConfirmationId,
      reason: body.reason
    });
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof ReviewValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ReviewNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ReviewConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "Review approval conflict. Try refreshing and retrying." }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
