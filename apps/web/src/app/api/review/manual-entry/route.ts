import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { createManualLoad } from "@/server/review";

const manualEntrySchema = z.object({
  regionId: z.string().min(1).optional(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shipperName: z.string().trim().max(120).optional(),
  receiverName: z.string().trim().max(120).optional(),
  lineHaulRate: z.coerce.number().positive(),
  loadedMiles: z.coerce.number().positive(),
  puDeadheadMiles: z.coerce.number().min(0).default(0),
  delDeadheadMiles: z.coerce.number().min(0).default(0),
  fscApplies: z.boolean().default(false),
  driverType: z.enum(["SHUTTLE", "PTP", "LTL"]).optional()
});

async function resolveRegion(requestedRegionId: string | undefined, bypassAuth: boolean): Promise<string> {
  if (requestedRegionId && requestedRegionId.trim().length > 0) {
    return requestedRegionId.trim();
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

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actorUserId = userId ?? "dev-bypass-user";
    const body = manualEntrySchema.parse(await request.json());
    const regionId = await resolveRegion(body.regionId, bypassAuth);
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "BOARD", action: "WRITE" });
    }

    const result = await createManualLoad({
      actorId: actorUserId,
      regionId,
      pickupDate: new Date(`${body.pickupDate}T12:00:00.000Z`),
      deliveryDate: body.deliveryDate ? new Date(`${body.deliveryDate}T12:00:00.000Z`) : null,
      shipperName: body.shipperName || undefined,
      receiverName: body.receiverName || undefined,
      lineHaulRate: new Prisma.Decimal(body.lineHaulRate),
      loadedMiles: new Prisma.Decimal(body.loadedMiles),
      puDeadheadMiles: new Prisma.Decimal(body.puDeadheadMiles),
      delDeadheadMiles: new Prisma.Decimal(body.delDeadheadMiles),
      fscApplies: body.fscApplies,
      driverType: body.driverType
    });

    return NextResponse.json({ loadId: result.loadId, regionId }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
