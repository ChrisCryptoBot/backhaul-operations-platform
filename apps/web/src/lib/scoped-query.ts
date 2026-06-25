import { Prisma } from "@prisma/client";

export interface ScopedWhere {
  regionId: string;
}

export function withRegionScope<T extends object>(regionId: string, where?: T): T & ScopedWhere {
  return {
    ...(where ?? ({} as T)),
    regionId
  };
}

export function withNonDeletedRegionScope<T extends object>(
  regionId: string,
  where?: T
): T & ScopedWhere & { deletedAt: null } {
  return {
    ...(where ?? ({} as T)),
    regionId,
    deletedAt: null
  };
}

export function scopedRawRegion(regionId: string): Prisma.Sql {
  return Prisma.sql`"regionId" = ${regionId}`;
}

