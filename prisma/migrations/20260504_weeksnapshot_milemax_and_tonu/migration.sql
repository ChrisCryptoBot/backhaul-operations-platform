ALTER TABLE "WeekSnapshot"
ADD COLUMN "totalAllInRevenue" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "totalTonuAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN "mileMaxRpm" DECIMAL(12,4);

UPDATE "WeekSnapshot"
SET "totalAllInRevenue" = COALESCE("lineHaulRevenue", 0) + COALESCE("fuelSurchargeAmount", 0),
    "totalTonuAmount" = 0,
    "mileMaxRpm" = CASE WHEN COALESCE("totalTripMiles", 0) > 0
      THEN (COALESCE("lineHaulRevenue", 0) + COALESCE("fuelSurchargeAmount", 0)) / NULLIF("totalTripMiles", 0)
      ELSE NULL END;

