-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM (
  'BOOKED',
  'DISPATCHED',
  'PICKED_UP',
  'DELIVERED',
  'POD_RECEIVED',
  'COMPLETED',
  'CANCELED',
  'FAILED'
);

-- AlterTable
ALTER TABLE "Load"
ADD COLUMN "status" "LoadStatus" NOT NULL DEFAULT 'BOOKED',
ADD COLUMN "createdById" TEXT;

-- Backfill createdById from load create audit when available
UPDATE "Load" l
SET "createdById" = a."actorId"
FROM "AuditLog" a
WHERE a."entityType" = 'Load'
  AND a."entityId" = l."id"
  AND a."action" = 'CREATE'
  AND l."createdById" IS NULL;

-- Fallback for rows without audit linkage (keeps migration deterministic)
DO $$
DECLARE
  fallback_user_id TEXT := 'system-migration-user';
BEGIN
  IF EXISTS (SELECT 1 FROM "Load" WHERE "createdById" IS NULL) THEN
    INSERT INTO "User" ("id", "email", "name", "createdAt", "updatedAt")
    VALUES (fallback_user_id, 'system-migration-user@local.invalid', 'System Migration User', NOW(), NOW())
    ON CONFLICT ("id") DO NOTHING;

    UPDATE "Load"
    SET "createdById" = fallback_user_id
    WHERE "createdById" IS NULL;
  END IF;
END $$;

ALTER TABLE "Load"
ALTER COLUMN "createdById" SET NOT NULL;

-- Extend WeekSnapshot aggregates for phase-1 KPI rollups
ALTER TABLE "WeekSnapshot"
ADD COLUMN "totalLoadedMiles" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "totalPickupDeadhead" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "totalDeliveryDeadhead" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "totalEmptyMiles" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "totalTripMiles" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "emptyMilePct" DECIMAL(8,4),
ADD COLUMN "negFloorRpm" DECIMAL(12,4);

-- AddForeignKey
ALTER TABLE "Load"
ADD CONSTRAINT "Load_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add uniqueness for one rate confirmation per load
CREATE UNIQUE INDEX "Load_rateConfirmationId_key" ON "Load"("rateConfirmationId");

-- Enforce FuelSurchargeIndex actor integrity
INSERT INTO "User" ("id", "email", "name", "createdAt", "updatedAt")
SELECT DISTINCT f."updatedByUserId",
  CONCAT('migration-fsc-', f."updatedByUserId", '@local.invalid'),
  'Migrated FSC Actor',
  NOW(),
  NOW()
FROM "FuelSurchargeIndex" f
LEFT JOIN "User" u ON u."id" = f."updatedByUserId"
WHERE u."id" IS NULL
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "FuelSurchargeIndex"
ADD CONSTRAINT "FuelSurchargeIndex_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
