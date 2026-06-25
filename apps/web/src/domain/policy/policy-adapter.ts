import type { Role } from "@/lib/rbac";
import { requireRole } from "@/lib/rbac";
import { requireRegionAccess, type RegionAccess } from "@/lib/access";
import { assertPermission, type PolicyPermission } from "@/domain/policy/permissions";

export interface PolicyAdapter {
  requireRegionAccess(userId: string, regionId: string): Promise<RegionAccess>;
  requireMinimumRole(ctx: { userId: string; role: Role; regionId: string }, minimumRole: Role): void;
  assertPermission(ctx: { userId: string; role: Role; regionId: string }, permission: PolicyPermission): void;
}

class DefaultPolicyAdapter implements PolicyAdapter {
  async requireRegionAccess(userId: string, regionId: string): Promise<RegionAccess> {
    return requireRegionAccess(userId, regionId);
  }

  requireMinimumRole(ctx: { userId: string; role: Role; regionId: string }, minimumRole: Role): void {
    requireRole(ctx, minimumRole);
  }

  assertPermission(ctx: { userId: string; role: Role; regionId: string }, permission: PolicyPermission): void {
    assertPermission(ctx.role, permission);
  }
}

export const policyAdapter: PolicyAdapter = new DefaultPolicyAdapter();

