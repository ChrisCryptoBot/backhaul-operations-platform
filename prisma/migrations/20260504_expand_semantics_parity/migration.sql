-- Expand step for semantic parity rollout (dual-read/dual-write compatible)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TaskDoneStatus') THEN
    CREATE TYPE "TaskDoneStatus" AS ENUM ('NOT_DONE', 'DONE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LineHaulPricingModel') THEN
    CREATE TYPE "LineHaulPricingModel" AS ENUM ('FLAT', 'FLAT_PLUS_FUEL', 'OTHER');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "RateConfirmation"
ADD COLUMN "contractVersion" VARCHAR(16);

-- AlterTable
ALTER TABLE "Load"
ADD COLUMN "pickupNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "mgStatusTask" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN "tmwStatusTask" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN "lineHaulPricingModel" "LineHaulPricingModel" NOT NULL DEFAULT 'FLAT',
ADD COLUMN "isTONU" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tonuAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "allInRevenue" DECIMAL(12,4) NOT NULL DEFAULT 0;

-- Backfill all-in revenue from legacy columns (line haul + fsc)
UPDATE "Load"
SET "allInRevenue" = COALESCE("lineHaulRate", 0) + COALESCE("fscAmount", 0);

-- Backfill multi-pickup list from legacy pickupNumber when present
UPDATE "Load"
SET "pickupNumbers" = ARRAY["pickupNumber"]
WHERE "pickupNumber" IS NOT NULL
  AND COALESCE(array_length("pickupNumbers", 1), 0) = 0;

