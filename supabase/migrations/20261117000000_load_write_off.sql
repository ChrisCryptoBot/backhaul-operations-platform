-- Generated from prisma/migrations/20261117000000_load_write_off/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- What was written off when an invoice was closed short, and why, so revenue and cash can be reconciled. Nullable; nothing existing changes.
ALTER TABLE "loads" ADD COLUMN "write_off_amount" DECIMAL(12,2);
ALTER TABLE "loads" ADD COLUMN "write_off_reason" TEXT;
