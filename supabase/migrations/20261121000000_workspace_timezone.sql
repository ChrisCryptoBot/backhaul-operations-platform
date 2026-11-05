-- Generated from prisma/migrations/20261121000000_workspace_timezone/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- The carrier's own clock: where billing days, aging, weekly limits, statement weeks and "this month" are counted (src/lib/tz.ts). Existing fleets keep Central, which is what the desk always used.
ALTER TABLE "workspaces" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Chicago';
