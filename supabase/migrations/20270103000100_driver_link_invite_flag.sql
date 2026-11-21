-- Generated from prisma/migrations/20270103000100_driver_link_invite_flag/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Phase 2 step 1: a claim flagged because the phone account already belongs to another driver is recorded once per claim, not on every pull.
ALTER TABLE "driver_link_invites" ADD COLUMN "flagged_for" TEXT;
