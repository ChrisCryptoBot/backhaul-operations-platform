import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { isWriteBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { prisma as globalPrisma, runInRegionScope } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { recomputeWeekSnapshot } from "@/server/snapshots";

const inboundPayloadSchema = z.object({
  regionId: z.string().min(1),
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  inboundRevenue: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  inboundLoadedMiles: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  reason: z.string().min(10)
});

export async function PATCH(request: Request) {
  try {
    const { userId } = await auth();
    const bypassWrites = isWriteBypassed();
    if (!bypassWrites && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";

    const payload = inboundPayloadSchema.parse(await request.json());

    const access = bypassWrites
      ? { userId: "dev-bypass-user", regionId: payload.regionId, role: "ADMIN" as const }
      : await policyAdapter.requireRegionAccess(actorUserId, payload.regionId);
    if (!bypassWrites) {
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "WRITE" });
    }

    const inboundRevenue = new Prisma.Decimal(payload.inboundRevenue ?? "0");
    const inboundLoadedMiles = new Prisma.Decimal(payload.inboundLoadedMiles ?? "0");

    await runInRegionScope(payload.regionId, async (tx) => {
      const existing = await tx.weekSnapshot.findUnique({
        where: { regionId_weekIso: { regionId: payload.regionId, weekIso: payload.weekIso } }
      });
      if (existing?.lockedAt) {
        throw new PolicyViolationError("Week snapshot is locked and cannot be modified.");
      }
      await tx.weekSnapshot.upsert({
        where: { regionId_weekIso: { regionId: payload.regionId, weekIso: payload.weekIso } },
        update: { inboundRevenue, inboundLoadedMiles },
        create: {
          regionId: payload.regionId,
          weekIso: payload.weekIso,
          inboundRevenue,
          inboundLoadedMiles,
          loadCount: 0,
          lineHaulRevenue: new Prisma.Decimal(0),
          fuelSurchargeAmount: new Prisma.Decimal(0),
          totalLoadedMiles: new Prisma.Decimal(0),
          totalPickupDeadhead: new Prisma.Decimal(0),
          totalDeliveryDeadhead: new Prisma.Decimal(0),
          totalEmptyMiles: new Prisma.Decimal(0),
          totalTripMiles: new Prisma.Decimal(0),
          totalAllInRevenue: new Prisma.Decimal(0),
          totalTonuAmount: new Prisma.Decimal(0),
          mileMaxMissingInbound: inboundRevenue.isZero() && inboundLoadedMiles.isZero()
        }
      });
      await tx.auditLog.create({
        data: createAuditLog({
          entityType: "WeekSnapshot",
          entityId: `${payload.regionId}:${payload.weekIso}`,
          action: "UPDATE",
          actorId: actorUserId,
          timestamp: new Date(),
          reason: payload.reason,
          afterValue: { inboundRevenue: inboundRevenue.toString(), inboundLoadedMiles: inboundLoadedMiles.toString() }
        })
      });
    });

    await recomputeWeekSnapshot(payload.regionId, payload.weekIso, actorUserId, globalPrisma);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
