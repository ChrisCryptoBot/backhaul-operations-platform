import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { resolvePhase1RegionId } from "@/lib/scope";
import { listAuditLog } from "@/server/audit-read";

const querySchema = z.object({
  entityType: z.string().min(1).max(120).optional(),
  action: z.string().min(1).max(120).optional(),
  actorId: z.string().min(1).max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

/**
 * Gate audit reads to admins. In dev (BYPASS_AUTH) the viewer is treated as ADMIN so the page is
 * browsable without Clerk; in production a SYSTEM_SETTINGS:READ permission is required.
 */
async function requireAuditAccess(): Promise<NextResponse | null> {
  const bypass = isAuthBypassed();
  const { userId } = await auth();
  if (bypass) return null;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const regionId = await resolvePhase1RegionId();
  const access = await policyAdapter.requireRegionAccess(userId, regionId);
  policyAdapter.assertPermission(access, { resource: "SYSTEM_SETTINGS", action: "READ" });
  return null;
}

export async function GET(request: Request) {
  try {
    const denied = await requireAuditAccess();
    if (denied) return denied;

    const url = new URL(request.url);
    const parsed = querySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const page = await listAuditLog({
      entityType: parsed.entityType,
      action: parsed.action,
      actorId: parsed.actorId,
      from: parsed.from ? new Date(parsed.from) : undefined,
      to: parsed.to ? new Date(parsed.to) : undefined,
      search: parsed.search,
      cursor: parsed.cursor,
      limit: parsed.limit
    });

    return NextResponse.json(page, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid query", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
