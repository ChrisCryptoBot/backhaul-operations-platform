-- Generated from prisma/migrations/20270108000000_dispatcher_names/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Who sent it (Chris 2026-11-22: a company with several dispatchers is one connection; the driver sees which dispatcher sent an offer or a message).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sent_by" TEXT;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "dispatched_by" TEXT;
