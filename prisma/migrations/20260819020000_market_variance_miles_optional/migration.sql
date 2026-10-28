-- Make miles + per-mile columns optional on MarketVarianceEntry so a totals-only
-- (spreadsheet-style) entry stores NULL instead of a fabricated 0 / $0.00/mi.
-- Safe widening: existing rows keep their current values.
ALTER TABLE "MarketVarianceEntry" ALTER COLUMN "negotiatedPerMile" DROP NOT NULL;
ALTER TABLE "MarketVarianceEntry" ALTER COLUMN "miles" DROP NOT NULL;
ALTER TABLE "MarketVarianceEntry" ALTER COLUMN "milesSource" DROP NOT NULL;
ALTER TABLE "MarketVarianceEntry" ALTER COLUMN "marketPerMile" DROP NOT NULL;
ALTER TABLE "MarketVarianceEntry" ALTER COLUMN "variancePerMile" DROP NOT NULL;
