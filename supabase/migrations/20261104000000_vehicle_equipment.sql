-- Generated from prisma/migrations/20261104000000_vehicle_equipment/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Trucks say what they carry (liftgate, ramp, pallet jack) so a load that needs one can be checked against them.
ALTER TABLE "vehicles"
  ADD COLUMN "has_liftgate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "has_ramp" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "has_pallet_jack" BOOLEAN NOT NULL DEFAULT false;
