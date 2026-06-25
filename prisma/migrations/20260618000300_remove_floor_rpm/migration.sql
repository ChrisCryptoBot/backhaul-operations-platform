-- Remove the negotiation floor rate-per-mile metric from the data model.
ALTER TABLE "Load" DROP COLUMN IF EXISTS "negotiationFloorRpm";
ALTER TABLE "WeekSnapshot" DROP COLUMN IF EXISTS "negFloorRpm";
