import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import {
  BoardRuleError,
  SoftGateError,
  deleteBoardLoadLeg,
  getBoardResponse,
  moveBoardLoad,
  rescheduleBoardLoadDelivery,
  setBoardLoadStatus,
  setLoadTonuLifecycle,
  softDeleteBoardLoad,
  updateBoardLoadFields,
  upsertBoardLoadLeg
} from "@/server/board";
import { isAuthBypassed } from "@/lib/auth-mode";
import { isIsoDay, todayIsoInTimeZone } from "@/lib/board-date";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { boardMutationSchema } from "./schema";

const boardQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  regionId: z.string().min(1).optional()
});

async function resolveBoardRegion(input: {
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
    const requestedDate = searchParams.get("date");
    const requestedRegionId = searchParams.get("regionId");
    const date = bypassAuth
      ? (isIsoDay(requestedDate) ? requestedDate : todayIsoInTimeZone())
      : boardQuerySchema.parse({ date: requestedDate, regionId: requestedRegionId ?? undefined }).date;

    const regionId = await resolveBoardRegion({ requestedRegionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "BOARD", action: "READ" });
    }
    const board = await getBoardResponse({
      regionId,
      date
    });

    return NextResponse.json(board, { status: 200 });
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
    const body = boardMutationSchema.parse(await request.json());

    const regionId = await resolveBoardRegion({ requestedRegionId: body.regionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "BOARD", action: "WRITE" });
    }

    if (body.action === "move") {
      await moveBoardLoad({
        regionId,
        loadId: body.loadId,
        targetSectionId: body.targetSectionId,
        actorId: actorUserId
      });
    } else if (body.action === "tonu") {
      await setLoadTonuLifecycle({
        regionId,
        loadId: body.loadId,
        isTonu: body.isTonu,
        tonuAmount: body.tonuAmount ?? null,
        actorId: actorUserId
      });
    } else if (body.action === "status") {
      await setBoardLoadStatus({
        regionId,
        loadId: body.loadId,
        status: body.status,
        actorId: actorUserId,
        overrideReason: body.overrideReason
      });
    } else if (body.action === "update-fields") {
      await updateBoardLoadFields({
        regionId,
        loadId: body.loadId,
        actorId: actorUserId,
        fields: body.fields
      });
    } else if (body.action === "delete") {
      await softDeleteBoardLoad({
        regionId,
        loadId: body.loadId,
        reason: body.reason,
        actorId: actorUserId
      });
    } else if (body.action === "leg-upsert") {
      await upsertBoardLoadLeg({
        regionId,
        loadId: body.loadId,
        actorId: actorUserId,
        leg: body.leg
      });
    } else if (body.action === "leg-delete") {
      await deleteBoardLoadLeg({
        regionId,
        loadId: body.loadId,
        legId: body.legId,
        actorId: actorUserId
      });
    } else if (body.action === "reschedule-delivery") {
      await rescheduleBoardLoadDelivery({
        regionId,
        loadId: body.loadId,
        actorId: actorUserId,
        date: body.newDate,
        windowStart: body.windowStart,
        windowEnd: body.windowEnd,
        apptType: body.apptType
      });
    }

    const board = await getBoardResponse({
      regionId,
      date: body.date
    });
    return NextResponse.json(board, { status: 200 });
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
    if (error instanceof SoftGateError) {
      return NextResponse.json(
        { error: error.message, needsOverrideReason: true, openItems: error.openItems },
        { status: 409 }
      );
    }
    if (error instanceof BoardRuleError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
