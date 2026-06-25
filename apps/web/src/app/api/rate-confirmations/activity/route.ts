import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { isAuthBypassed } from "@/lib/auth-mode";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { getRateConfirmationActivity } from "@/server/rate-confirmation-activity";
import { isIsoDay, todayIsoInTimeZone } from "@/lib/board-date";
import { policyAdapter } from "@/domain/policy/policy-adapter";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  regionId: z.string().min(1).optional()
});

async function resolveActivityRegion(input: {
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
    const searchParams = new URL(request.url).searchParams;
    const dateParam = searchParams.get("date");
    const regionParam = searchParams.get("regionId");
    const date = bypassAuth
      ? (isIsoDay(dateParam) ? dateParam : todayIsoInTimeZone())
      : schema.parse({ date: dateParam, regionId: regionParam ?? undefined }).date;

    let regionId = "dev-region";
    try {
      regionId = await resolveActivityRegion({ requestedRegionId: regionParam, bypassAuth });
      if (!bypassAuth) {
        const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
        policyAdapter.assertPermission(access, { resource: "BOARD", action: "READ" });
      }
    } catch (error) {
      if (!bypassAuth) {
        throw error;
      }
    }

    const payload = await getRateConfirmationActivity({ regionId, date });
    return NextResponse.json(payload, { status: 200 });
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
