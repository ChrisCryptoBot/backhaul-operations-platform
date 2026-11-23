-- Generated from prisma/migrations/20270107000000_driver_link_kinds/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Sync plan Step 3 (connection kinds): what a contractor's link code carries, kept with the invite (the bridge row carries the same, for the phone's connection rules).
ALTER TABLE "driver_link_invites" ADD COLUMN IF NOT EXISTS "forced_dispatch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_link_invites" ADD COLUMN IF NOT EXISTS "under_authority" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_link_invites" ADD COLUMN IF NOT EXISTS "sponsored" BOOLEAN NOT NULL DEFAULT false;
