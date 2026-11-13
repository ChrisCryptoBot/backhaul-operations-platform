-- Generated from prisma/migrations/20261229000000_factoring_dates/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Money plan Wave 6 step 1: the day the factor released the reserve, and the day it charged an invoice back, each kept as its own date (they were read from factoring_updated_at).
ALTER TABLE "invoices" ADD COLUMN "factoring_reserve_released_at" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "factoring_charged_back_at" TIMESTAMP(3);

-- The same day the journal and the QuickBooks sync have booked the release on so far (paid_at, else the last factoring change, else the funding day), so nothing already exported moves.
UPDATE "invoices" SET "factoring_reserve_released_at" = COALESCE("paid_at", "factoring_updated_at", "factoring_funded_at")
WHERE "factoring_reserve_released" IS NOT NULL AND "factoring_chargeback" IS NULL;

-- A chargeback was dated by the last factoring change; a rejected invoice takes no later factoring change, so that is the day it was charged back.
UPDATE "invoices" SET "factoring_charged_back_at" = "factoring_updated_at"
WHERE "factoring_chargeback" IS NOT NULL;
