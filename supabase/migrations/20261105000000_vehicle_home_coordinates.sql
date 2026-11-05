-- Generated from prisma/migrations/20261105000000_vehicle_home_coordinates/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Where a truck is based, found once, so measuring a quote does not geocode the address again.
ALTER TABLE "vehicles"
  ADD COLUMN "home_base_lat" DECIMAL(9,6),
  ADD COLUMN "home_base_lng" DECIMAL(9,6);
