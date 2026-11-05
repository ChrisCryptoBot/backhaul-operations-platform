-- Generated from prisma/migrations/20261102000000_loaded_hours/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- AlterTable
ALTER TABLE "loads" ADD COLUMN     "estimated_loaded_hours" DECIMAL(8,2);

