-- Generated from prisma/migrations/20261203000000_imported_history/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Imported weekly history (docs/LOAD_IMPORT.md): lane-per-week totals from a carrier's own tracker, kept apart from loads. It feeds the trends only and is never added to a figure built from loads.
-- Row level security: new tables start with it off. On a Supabase database run supabase/lockdown_rls.sql again after applying this.

CREATE TABLE "imported_history" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "week_start" DATE NOT NULL,
  "lane" TEXT NOT NULL,
  "loads" INTEGER NOT NULL,
  "line_haul" DECIMAL(12,2) NOT NULL,
  "fuel_surcharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "loaded_miles" DECIMAL(12,1) NOT NULL,
  "empty_miles" DECIMAL(12,1) NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "imported_history_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "imported_history_workspace_id_week_start_lane_key" ON "imported_history"("workspace_id", "week_start", "lane");
CREATE INDEX "imported_history_workspace_id_batch_id_idx" ON "imported_history"("workspace_id", "batch_id");
ALTER TABLE "imported_history" ADD CONSTRAINT "imported_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
