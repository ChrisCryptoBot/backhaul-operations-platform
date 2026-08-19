-- Configurable ± band threshold for the Market Variance module. Additive.
ALTER TABLE "RegionConfig" ADD COLUMN "marketVarianceBandPct" DECIMAL(5,2) NOT NULL DEFAULT 10;
