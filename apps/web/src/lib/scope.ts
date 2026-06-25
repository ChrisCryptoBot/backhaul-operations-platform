import type { AccessContext } from "./rbac";
import { prisma } from "./db";
import { getPhase1RegionCode } from "./env";
import { PolicyViolationError } from "./policy-error";
import { isAuthBypassed } from "./auth-mode";

let cachedPhase1RegionId: string | null = null;

export async function resolvePhase1RegionId(): Promise<string> {
  if (cachedPhase1RegionId) {
    return cachedPhase1RegionId;
  }

  const PHASE1_REGION_CODE = getPhase1RegionCode();
  const region = await prisma.region.findUnique({
    where: { code: PHASE1_REGION_CODE },
    select: { id: true }
  });

  if (region) {
    cachedPhase1RegionId = region.id;
    return region.id;
  }

  if (isAuthBypassed()) {
    const fallbackRegion = await prisma.region.findFirst({
      where: {},
      orderBy: { createdAt: "asc" },
      select: { id: true }
    });
    if (fallbackRegion) {
      cachedPhase1RegionId = fallbackRegion.id;
      return fallbackRegion.id;
    }
  }

  throw new Error(`Phase 1 region code ${PHASE1_REGION_CODE} is not seeded`);
}

export async function assertRegionAccess(ctx: AccessContext, regionId: string): Promise<void> {
  if (
    process.env.MULTIREGION_POLICY_MODE === "expanded" &&
    (ctx.role === "CORPORATE_OPS" || ctx.role === "ADMIN")
  ) {
    return;
  }

  const phase1RegionId = await resolvePhase1RegionId();
  if (ctx.regionId !== phase1RegionId) {
    throw new PolicyViolationError(`Phase 1 is configured for region ${phase1RegionId}. Received ${ctx.regionId}`);
  }

  if (regionId !== ctx.regionId) {
    throw new PolicyViolationError(`User region ${ctx.regionId} cannot access ${regionId}`);
  }
}
