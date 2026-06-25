import { Prisma } from "@prisma/client";

export interface AuditLogInput {
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  timestamp: Date;
  reason?: string;
  beforeValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  afterValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
}

export function createAuditLog(input: AuditLogInput): Prisma.AuditLogUncheckedCreateInput {
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actorId: input.actorId,
    timestamp: input.timestamp,
    reason: input.reason,
    beforeValue: input.beforeValue,
    afterValue: input.afterValue
  };
}
