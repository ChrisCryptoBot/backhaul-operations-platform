import { Prisma } from "@prisma/client";
import { prisma, runInRegionScope } from "@/lib/db";

export async function listAccessibleRegions(userId: string | null): Promise<Array<{ id: string; code: string; name: string }>> {
  if (!userId) {
    return prisma.region.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" }
    });
  }

  const memberships = await prisma.userRegionRole.findMany({
    where: { userId },
    include: { region: { select: { id: true, code: true, name: true } } },
    orderBy: { region: { code: "asc" } }
  });
  return memberships.map((membership) => membership.region);
}

export async function writeKpiGovernanceEvent(input: {
  regionId: string;
  actorId: string;
  action: "EXPORT_CSV" | "EXPORT_PDF" | "EMAIL_SUMMARY" | "ACK_ALERT";
  entityId: string;
  reason?: string;
  afterValue?: unknown;
}): Promise<void> {
  await runInRegionScope(input.regionId, async (tx) => {
    await tx.auditLog.create({
      data: {
        entityType: "KPI_DASHBOARD",
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId,
        reason: input.reason ?? null,
        afterValue: (input.afterValue ?? Prisma.JsonNull) as Prisma.InputJsonValue
      }
    });
  });
}
