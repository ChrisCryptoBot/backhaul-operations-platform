-- Generated from prisma/migrations/20261114000000_card_lane_thresholds/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- The verdict card's two lane thresholds, one nullable column each. Null = use the built-in default (3 loads, 90 days), so nothing existing changes.
ALTER TABLE "workspaces" ADD COLUMN "lane_min_loads" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "lane_days" INTEGER;
