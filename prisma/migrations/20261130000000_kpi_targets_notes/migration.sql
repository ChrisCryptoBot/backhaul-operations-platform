-- KPI quick wins (docs/LEAK_AUDIT_2026-11.md): a target rate per lane, the weekly diesel price kept as it is read, and a note for the weekly call.
-- Row level security: new tables start with it off. On a Supabase database run supabase/lockdown_rls.sql again after applying this.

CREATE TABLE "lane_targets" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "lane" TEXT NOT NULL,
  "target_rate" DECIMAL(12,2) NOT NULL,
  "set_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lane_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lane_targets_workspace_id_lane_key" ON "lane_targets"("workspace_id", "lane");
ALTER TABLE "lane_targets" ADD CONSTRAINT "lane_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "diesel_prices" (
  "id" TEXT NOT NULL,
  "week_of" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "price" DECIMAL(6,3) NOT NULL,
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "diesel_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "diesel_prices_week_of_region_key" ON "diesel_prices"("week_of", "region");

CREATE TABLE "kpi_notes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "week_key" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kpi_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "kpi_notes_workspace_id_week_key_key" ON "kpi_notes"("workspace_id", "week_key");
ALTER TABLE "kpi_notes" ADD CONSTRAINT "kpi_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
