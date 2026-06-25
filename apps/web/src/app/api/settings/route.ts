import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isWriteBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { resolvePhase1RegionId } from "@/lib/scope";
import type { AccessContext } from "@/lib/rbac";
import { getLlmSettingsStatus, updateLlmSettings } from "@/server/llm/settings";
import { SUPPORTED_PROVIDERS } from "@/server/llm/registry";

const settingsPayloadSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).max(128),
  copilotModel: z.string().max(128).nullable().optional(),
  // Optional: omit/empty to keep the existing stored key.
  apiKey: z.string().max(512).optional(),
  isActive: z.boolean().optional()
});

/**
 * Resolves the caller's access context (ADMIN-gated). Settings are system-wide,
 * so we resolve the role against the Phase 1 region and assert the
 * SYSTEM_SETTINGS permission (granted to ADMIN only).
 */
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
    if (access instanceof NextResponse) {
      return access;
    }
    const status = await getLlmSettingsStatus();
    return NextResponse.json({ supportedProviders: SUPPORTED_PROVIDERS, settings: status }, { status: 200 });
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
    if (access instanceof NextResponse) {
      return access;
    }

    const payload = settingsPayloadSchema.parse(await request.json());
    if (!SUPPORTED_PROVIDERS.includes(payload.provider)) {
      return NextResponse.json(
        { error: `Unsupported provider. Supported: ${SUPPORTED_PROVIDERS.join(", ")}` },
        { status: 400 }
      );
    }

    const status = await updateLlmSettings({
      actorId: access.userId,
      provider: payload.provider,
      model: payload.model,
      copilotModel: payload.copilotModel,
      apiKey: payload.apiKey,
      isActive: payload.isActive
    });

    return NextResponse.json({ ok: true, settings: status }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    const msg = error instanceof Error ? error.message : "Internal server error";
    if (msg.includes("CONFIG_ENCRYPTION_KEY")) {
      return NextResponse.json(
        { error: "Server is missing CONFIG_ENCRYPTION_KEY; cannot store the API key securely." },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
