import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isWriteBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { resolvePhase1RegionId } from "@/lib/scope";
import type { AccessContext } from "@/lib/rbac";
import { getRegionConfig, RegionConfigValidationError, updateRegionConfig } from "@/server/region-config";

const thresholdPattern = /^\d{1,3}(\.\d{1,2})?$/;
const payloadSchema = z.object({
  emptyPctAmber: z.string().regex(thresholdPattern).optional(),
  emptyPctRed: z.string().regex(thresholdPattern).optional(),
  emptyPctAlert: z.string().regex(thresholdPattern).optional(),
  reason: z.string().max(280).optional()
});

async function requireSettingsAccess(action: "READ" | "WRITE"): Promise<AccessContext | NextResponse> {
  const { userId } = await auth();
  const bypass = isWriteBypassed();
  if (!bypass && !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const regionId = await resolvePhase1RegionId();
  const access: AccessContext = bypass
    ? { userId: "dev-bypass-user", regionId, role: "ADMIN" }
    : await policyAdapter.requireRegionAccess(userId!, regionId);
  if (!bypass) {
    policyAdapter.assertPermission(access, { resource: "SYSTEM_SETTINGS", action });
  }
  return access;
}

export async function GET() {
  try {
    const access = await requireSettingsAccess("READ");
    if (access instanceof NextResponse) return access;
    const config = await getRegionConfig(access.regionId);
    return NextResponse.json({ config }, { status: 200 });
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireSettingsAccess("WRITE");
    if (access instanceof NextResponse) return access;

    const payload = payloadSchema.parse(await request.json());
    const config = await updateRegionConfig({
      actorId: access.userId,
      regionId: access.regionId,
      emptyPctAmber: payload.emptyPctAmber,
      emptyPctRed: payload.emptyPctRed,
      emptyPctAlert: payload.emptyPctAlert,
      reason: payload.reason ?? "Updated via settings"
    });
    return NextResponse.json({ ok: true, config }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof RegionConfigValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
