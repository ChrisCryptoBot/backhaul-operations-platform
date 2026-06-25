import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isWriteBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { setLaneWeeklyTarget } from "@/server/lane-week-write";

const laneTargetPayloadSchema = z.object({
  regionId: z.string().min(1),
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  lane: z.string().min(1),
  targetRate: z.string().max(32)
});

export async function PATCH(request: Request) {
  try {
    const { userId } = await auth();
    const bypassWrites = isWriteBypassed();
    if (!bypassWrites && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const payload = laneTargetPayloadSchema.parse(await request.json());

    const normalizedTargetRate = payload.targetRate.trim();
    if (normalizedTargetRate.length > 0) {
      const parsed = Number(normalizedTargetRate);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "Target rate must be a positive number." }, { status: 422 });
      }
    }

    const access = bypassWrites
      ? { userId: "dev-bypass-user", regionId: payload.regionId, role: "ADMIN" as const }
      : await policyAdapter.requireRegionAccess(actorUserId, payload.regionId);
    if (!bypassWrites) {
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "WRITE" });
    }

    await setLaneWeeklyTarget({
      regionId: payload.regionId,
      weekIso: payload.weekIso,
      lane: payload.lane,
      targetRate: normalizedTargetRate,
      actorId: actorUserId
    });

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
