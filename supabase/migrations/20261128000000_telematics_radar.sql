-- Generated from prisma/migrations/20261128000000_telematics_radar/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Telematics radar, idle waste and trailer dwell (docs/TELEMATICS_RADAR.md). Everything is optional and written only by the ELD sync or by a person, so nothing existing changes.

-- What the ELD said about the engine at the last fix, per tractor.
ALTER TABLE "vehicles" ADD COLUMN "vin" TEXT,
ADD COLUMN "last_speed_mph" DECIMAL(5,1),
ADD COLUMN "last_heading_deg" INTEGER,
ADD COLUMN "engine_state" TEXT,
ADD COLUMN "idle_hours_today" DECIMAL(5,2),
ADD COLUMN "idle_since" TIMESTAMP(3);

-- A driver's licence number, read from a roster import.
ALTER TABLE "drivers" ADD COLUMN "license_number" TEXT;

-- Where a trailer is, when it was hooked or dropped, and a person's own dwell figure (a rate, the billable days, or the fee waived) for the current stay.
ALTER TABLE "trailers" ADD COLUMN "last_lat" DECIMAL(9,6),
ADD COLUMN "last_lng" DECIMAL(9,6),
ADD COLUMN "last_located_at" TIMESTAMP(3),
ADD COLUMN "hooked_at" TIMESTAMP(3),
ADD COLUMN "unhooked_at" TIMESTAMP(3),
ADD COLUMN "dwell_rate_override" DECIMAL(8,2),
ADD COLUMN "dwell_days_override" DECIMAL(6,2),
ADD COLUMN "dwell_waived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dwell_override_note" TEXT,
ADD COLUMN "dwell_override_by" TEXT,
ADD COLUMN "dwell_override_at" TIMESTAMP(3);

-- The company's dwell terms. Null = the built-in default (48 hours free, $75 a day).
ALTER TABLE "workspaces" ADD COLUMN "dwell_free_hours" INTEGER,
ADD COLUMN "dwell_per_day_rate" DECIMAL(8,2);

-- A week of position fixes per tractor.
CREATE TABLE "vehicle_pings" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vehicle_id" TEXT NOT NULL,
  "lat" DECIMAL(9,6) NOT NULL,
  "lng" DECIMAL(9,6) NOT NULL,
  "speed_mph" DECIMAL(5,1),
  "heading_deg" INTEGER,
  "engine" TEXT,
  "at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_pings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vehicle_pings_vehicle_id_at_key" ON "vehicle_pings"("vehicle_id", "at");
CREATE INDEX "vehicle_pings_vehicle_id_at_idx" ON "vehicle_pings"("vehicle_id", "at" DESC);
CREATE INDEX "vehicle_pings_workspace_id_at_idx" ON "vehicle_pings"("workspace_id", "at");
ALTER TABLE "vehicle_pings" ADD CONSTRAINT "vehicle_pings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_pings" ADD CONSTRAINT "vehicle_pings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
