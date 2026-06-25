-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('COORDINATOR', 'REGIONAL_MANAGER', 'CORPORATE_OPS', 'ADMIN');

-- CreateEnum
CREATE TYPE "FuelSurchargeSource" AS ENUM ('manual_tuesday', 'manual_override');

-- CreateEnum
CREATE TYPE "ParseState" AS ENUM ('UPLOADED', 'QUEUED', 'EXTRACTED', 'FAILED_INVALID', 'FAILED_TIMEOUT', 'FAILED_SCHEMA', 'FAILED_LOW_CONFIDENCE');

-- CreateEnum
CREATE TYPE "BrokerOnboardingStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "RuleSeverity" AS ENUM ('INFO', 'WARN', 'BLOCK');

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(4) NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DistributionCenter" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DistributionCenter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DropLot" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DropLot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lane" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "originCity" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "destinationCity" TEXT NOT NULL,
    "destinationState" TEXT NOT NULL,
    "targetRate" DECIMAL(12,4) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lane_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Broker" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "onboardingStatus" "BrokerOnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "fscDefaultApplies" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Broker_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrokerRep" (
    "id" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BrokerRep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RateConfirmation" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "sourceFileUrl" TEXT NOT NULL,
    "sourceFileHash" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "parseState" "ParseState" NOT NULL,
    "parseConfidence" DECIMAL(5,4),
    "extractedPayload" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Load" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "pickupDate" TIMESTAMP(3) NOT NULL,
    "dropLotId" TEXT,
    "rateConfirmationId" TEXT,
    "brokerId" TEXT,
    "bookingDate" TIMESTAMP(3),
    "routeId" TEXT,
    "loadNumber" TEXT,
    "pickupNumber" TEXT,
    "threePlRefNumber" TEXT,
    "eventCode" TEXT,
    "mgStatus" TEXT,
    "tmwStatus" TEXT,
    "pickupDriverAssigned" TEXT,
    "tractorTrailer1" TEXT,
    "tractorTrailer2" TEXT,
    "commodity" TEXT,
    "equipmentNeeds" TEXT,
    "lumperFeeAmount" DECIMAL(12,4),
    "shipperName" TEXT,
    "pickupCity" TEXT,
    "pickupState" TEXT,
    "pickupWindow" TEXT,
    "deliveryDriver" TEXT,
    "receiverName" TEXT,
    "deliveryCity" TEXT,
    "deliveryState" TEXT,
    "deliveryWindow" TEXT,
    "podStatus" TEXT,
    "lineHaulRate" DECIMAL(12,4) NOT NULL,
    "loadedMiles" DECIMAL(12,4) NOT NULL,
    "puDeadheadMiles" DECIMAL(12,4) NOT NULL,
    "delDeadheadMiles" DECIMAL(12,4) NOT NULL,
    "fscApplies" BOOLEAN NOT NULL,
    "fscRateUsed" DECIMAL(12,4),
    "fscAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "totalTripMiles" DECIMAL(12,4),
    "negotiableMiles" DECIMAL(12,4),
    "loadedRpm" DECIMAL(12,4),
    "negotiationFloorRpm" DECIMAL(12,4),
    "emptyMilePct" DECIMAL(8,4),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Load_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WeekSnapshot" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "loadCount" INTEGER NOT NULL DEFAULT 0,
    "lineHaulRevenue" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "fuelSurchargeAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WeekSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FuelSurchargeIndex" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "source" "FuelSurchargeSource" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "updateReason" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FuelSurchargeIndex_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalRule" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "RuleSeverity" NOT NULL,
    "statement" TEXT NOT NULL,
    "metadata" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperationalRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserRegionRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserRegionRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");
CREATE UNIQUE INDEX "Lane_regionId_originCity_originState_destinationCity_destin_key" ON "Lane"("regionId", "originCity", "originState", "destinationCity", "destinationState");
CREATE UNIQUE INDEX "RateConfirmation_sourceFileHash_key" ON "RateConfirmation"("sourceFileHash");
CREATE UNIQUE INDEX "RateConfirmation_idempotencyKey_key" ON "RateConfirmation"("idempotencyKey");
CREATE INDEX "RateConfirmation_regionId_weekIso_idx" ON "RateConfirmation"("regionId", "weekIso");
CREATE INDEX "Load_regionId_weekIso_idx" ON "Load"("regionId", "weekIso");
CREATE INDEX "Load_bookingDate_idx" ON "Load"("bookingDate");
CREATE INDEX "Load_regionId_dropLotId_bookingDate_idx" ON "Load"("regionId", "dropLotId", "bookingDate");
CREATE UNIQUE INDEX "WeekSnapshot_regionId_weekIso_key" ON "WeekSnapshot"("regionId", "weekIso");
CREATE INDEX "FuelSurchargeIndex_regionId_weekIso_source_idx" ON "FuelSurchargeIndex"("regionId", "weekIso", "source");
CREATE INDEX "FuelSurchargeIndex_regionId_weekIso_effectiveAt_idx" ON "FuelSurchargeIndex"("regionId", "weekIso", "effectiveAt" DESC);
CREATE UNIQUE INDEX "OperationalRule_regionId_code_key" ON "OperationalRule"("regionId", "code");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "UserRegionRole_userId_regionId_key" ON "UserRegionRole"("userId", "regionId");
CREATE INDEX "AuditLog_entityType_entityId_timestamp_idx" ON "AuditLog"("entityType", "entityId", "timestamp");
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

ALTER TABLE "DistributionCenter" ADD CONSTRAINT "DistributionCenter_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DropLot" ADD CONSTRAINT "DropLot_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lane" ADD CONSTRAINT "Lane_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Broker" ADD CONSTRAINT "Broker_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrokerRep" ADD CONSTRAINT "BrokerRep_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RateConfirmation" ADD CONSTRAINT "RateConfirmation_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Load" ADD CONSTRAINT "Load_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Load" ADD CONSTRAINT "Load_dropLotId_fkey" FOREIGN KEY ("dropLotId") REFERENCES "DropLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Load" ADD CONSTRAINT "Load_rateConfirmationId_fkey" FOREIGN KEY ("rateConfirmationId") REFERENCES "RateConfirmation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Load" ADD CONSTRAINT "Load_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WeekSnapshot" ADD CONSTRAINT "WeekSnapshot_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FuelSurchargeIndex" ADD CONSTRAINT "FuelSurchargeIndex_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperationalRule" ADD CONSTRAINT "OperationalRule_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserRegionRole" ADD CONSTRAINT "UserRegionRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRegionRole" ADD CONSTRAINT "UserRegionRole_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS prelude for region-scoped tables.
DO $$
BEGIN
  IF to_regclass('"RateConfirmation"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "RateConfirmation" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_rateconfirmation ON "RateConfirmation"';
    EXECUTE 'CREATE POLICY region_scope_rateconfirmation ON "RateConfirmation"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"Load"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "Load" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_load ON "Load"';
    EXECUTE 'CREATE POLICY region_scope_load ON "Load"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"Lane"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "Lane" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_lane ON "Lane"';
    EXECUTE 'CREATE POLICY region_scope_lane ON "Lane"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"Broker"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "Broker" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_broker ON "Broker"';
    EXECUTE 'CREATE POLICY region_scope_broker ON "Broker"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"OperationalRule"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "OperationalRule" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_oprule ON "OperationalRule"';
    EXECUTE 'CREATE POLICY region_scope_oprule ON "OperationalRule"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"WeekSnapshot"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "WeekSnapshot" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_weeksnapshot ON "WeekSnapshot"';
    EXECUTE 'CREATE POLICY region_scope_weeksnapshot ON "WeekSnapshot"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;

  IF to_regclass('"FuelSurchargeIndex"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "FuelSurchargeIndex" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS region_scope_fsc ON "FuelSurchargeIndex"';
    EXECUTE 'CREATE POLICY region_scope_fsc ON "FuelSurchargeIndex"
      USING ("regionId" = current_setting(''app.region_id'', true))
      WITH CHECK ("regionId" = current_setting(''app.region_id'', true))';
  END IF;
END $$;
