export type Role = "COORDINATOR" | "REGIONAL_MANAGER" | "CORPORATE_OPS" | "ADMIN";

export interface AccessContext {
  userId: string;
  role: Role;
  regionId: string;
}

const roleRank: Record<Role, number> = {
  COORDINATOR: 1,
  REGIONAL_MANAGER: 2,
  CORPORATE_OPS: 3,
  ADMIN: 4
};

export function requireRole(ctx: AccessContext, minimumRole: Role): void {
  if (roleRank[ctx.role] < roleRank[minimumRole]) {
    throw new Error(`Role ${ctx.role} is insufficient for ${minimumRole}`);
  }
}
