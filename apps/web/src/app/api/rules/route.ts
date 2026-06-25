import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isWriteBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { createOperationalRule } from "@/server/operational-rules";

const rulePayloadSchema = z.object({
  regionId: z.string().min(1),
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  title: z.string().min(1).max(200),
  severity: z.enum(["INFO", "WARN", "ACTION_REQUIRED"]),
  statement: z.string().min(1).max(2000),
  appliesTo: z.string().max(200).optional()
});

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassWrites = isWriteBypassed();
    if (!bypassWrites && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";

    const payload = rulePayloadSchema.parse(await request.json());

    const access = bypassWrites
      ? { userId: "dev-bypass-user", regionId: payload.regionId, role: "REGIONAL_MANAGER" as const }
      : await policyAdapter.requireRegionAccess(actorUserId, payload.regionId);
    if (!bypassWrites) {
      policyAdapter.assertPermission(access, { resource: "KPI_DASHBOARD", action: "WRITE" });
    }

    const { id } = await createOperationalRule({
      regionId: payload.regionId,
      actorId: actorUserId,
      code: payload.code,
      title: payload.title,
      severity: payload.severity,
      statement: payload.statement,
      appliesTo: payload.appliesTo
    });

    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    const msg = error instanceof Error ? error.message : "Internal server error";
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ error: "A rule with this code already exists for this region." }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
