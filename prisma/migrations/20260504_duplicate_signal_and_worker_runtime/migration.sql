-- Add duplicate signaling support for ingestion activity
CREATE TYPE "DuplicateSignal" AS ENUM ('EXACT_DUPLICATE', 'SOFT_DUPLICATE_WARNING');

ALTER TABLE "RateConfirmation"
ADD COLUMN "duplicateSignal" "DuplicateSignal";

