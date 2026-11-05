-- Generated from prisma/migrations/20261116000000_quote_decision_details/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- What a quote decision was made on, and by whom, for the Quote decisions report. Nullable; earlier decisions keep reading as they did.
ALTER TABLE "load_decisions" ADD COLUMN "details" JSONB;
ALTER TABLE "load_decisions" ADD COLUMN "decided_by" TEXT;
