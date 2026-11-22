-- Generated from prisma/migrations/20270106000000_bridge_stop_events/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Sync plan Step 2 (stop events): who set a stop's arrival, wait and seal, and how far the desk has read the phones' stop events.
-- arrived_source: 'desk' (a dispatcher entered or corrected it) or 'phone' (the driver's phone reported it). Null on rows from before: read as the desk's, so a phone never
-- overwrites them. The phone fills blanks and replaces only its own earlier values (server/bridge/stops.ts).
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "arrived_source" TEXT;
ALTER TABLE "stops" DROP CONSTRAINT IF EXISTS "stops_arrived_source_check";
ALTER TABLE "stops" ADD CONSTRAINT "stops_arrived_source_check" CHECK ("arrived_source" IS NULL OR "arrived_source" IN ('desk', 'phone'));
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "bridge_stop_cursor" BIGINT NOT NULL DEFAULT 0;
