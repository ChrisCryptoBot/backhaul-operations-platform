import type { Role } from "./rbac";
import { prisma } from "./db";
import { assertRegionAccess } from "./scope";
import { PolicyViolationError } from "./policy-error";
import { Role as PrismaRole } from "@prisma/client";

export interface RegionAccess {
  userId: string;
  regionId: string;
  role: Role;
}

function isDevAutoProvisionEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.AUTO_PROVISION_AUTH_USER === "true";
}

export async function requireRegionAccess(userId: string, regionId: string): Promise<RegionAccess> {
  let membership = await prisma.userRegionRole.findUnique({
    where: {
      userId_regionId: {
        userId,
        regionId
      }
    }
  });

  if (!membership && process.env.MULTIREGION_POLICY_MODE === "expanded") {
    const elevatedMembership = await prisma.userRegionRole.findFirst({
      where: {
        userId,
        role: { in: [PrismaRole.CORPORATE_OPS, PrismaRole.ADMIN] }
      },
      orderBy: { updatedAt: "desc" }
    });
    if (elevatedMembership) {
      membership = {
        ...elevatedMembership,
        regionId
      };
    }
  }

  if (!membership && isDevAutoProvisionEnabled()) {
    // Local/dev convenience: keep real Clerk auth, but provision region membership on first sign-in.
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@clerk.local`,
        name: "Clerk User"
      }
    });

    membership = await prisma.userRegionRole.upsert({
      where: {
        userId_regionId: {
          userId,
          regionId
        }
      },
      update: {},
      create: {
        userId,
        regionId,
        role: PrismaRole.ADMIN
      }
    });
  }

  if (!membership) {
    throw new PolicyViolationError("Forbidden for region");
  }

  await assertRegionAccess(
    {
      userId,
      regionId: membership.regionId,
      role: membership.role as Role
    },
    regionId
  );

  return {
    userId,
    regionId,
    role: membership.role as Role
  };
}
