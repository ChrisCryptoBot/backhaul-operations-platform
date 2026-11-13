-- Generated from prisma/migrations/20261225000000_ifta_mileage/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- ELD state-by-state miles (docs/MONEY_PLAN.md, Wave 5 step 5a). Additive.
--   ifta_mileage: one row per trip piece the ELD reported, per truck, quarter and US jurisdiction (DC included): loaded (on a load, `load_id`) or empty (`load_id` null), with the start and end
--   odometer and the start and end time, so the per-truck audit (step 7) has every mile's backing detail. `miles` is what the ELD measured for the piece. A piece belongs to the quarter it
--   STARTS in. `external_id` is the company's piece id and jurisdiction: a re-sync of the same truck and quarter replaces its rows under the workspace lock
--   (server/partners/ifta-mileage.ts), and the unique key is the backstop against a doubled piece. Canadian provinces are counted in the sync's result and audit but not stored (gap 15),
--   as step 4 does with Canadian rate rows. A piece whose load is later removed keeps `loaded` true with `load_id` null.

CREATE TABLE "ifta_mileage" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vehicle_id" TEXT NOT NULL,
  "quarter" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "load_id" TEXT,
  "loaded" BOOLEAN NOT NULL,
  "start_odometer" DECIMAL(12,1) NOT NULL,
  "end_odometer" DECIMAL(12,1) NOT NULL,
  "miles" DECIMAL(12,1) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3) NOT NULL,
  "sync_batch_id" TEXT NOT NULL,
  "synced_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ifta_mileage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ifta_mileage_quarter_check" CHECK ("quarter" ~ '^\d{4}-Q[1-4]$'),
  CONSTRAINT "ifta_mileage_jurisdiction_check" CHECK ("jurisdiction" IN ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY')),
  CONSTRAINT "ifta_mileage_miles_check" CHECK ("miles" >= 0),
  CONSTRAINT "ifta_mileage_odometer_check" CHECK ("end_odometer" >= "start_odometer"),
  CONSTRAINT "ifta_mileage_time_check" CHECK ("ended_at" >= "started_at"),
  CONSTRAINT "ifta_mileage_load_check" CHECK ("load_id" IS NULL OR "loaded")
);

CREATE UNIQUE INDEX "ifta_mileage_workspace_id_source_external_id_key" ON "ifta_mileage"("workspace_id", "source", "external_id");
CREATE INDEX "ifta_mileage_workspace_id_quarter_vehicle_id_idx" ON "ifta_mileage"("workspace_id", "quarter", "vehicle_id");
CREATE INDEX "ifta_mileage_load_id_idx" ON "ifta_mileage"("load_id");

ALTER TABLE "ifta_mileage" ADD CONSTRAINT "ifta_mileage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ifta_mileage" ADD CONSTRAINT "ifta_mileage_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ifta_mileage" ADD CONSTRAINT "ifta_mileage_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
