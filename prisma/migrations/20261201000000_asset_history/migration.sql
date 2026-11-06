-- Asset history (docs/ASSET_HISTORY.md): check calls kept with a truck or trailer, the stays of a tractor (where it stood and for how long, kept longer than the week of raw fixes), and a trailer's hooks and drops.
-- Everything is written by a person or by the ELD sync; nothing existing changes.

CREATE TABLE "check_calls" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vehicle_id" TEXT,
  "trailer_id" TEXT,
  "load_id" TEXT,
  "at" TIMESTAMP(3) NOT NULL,
  "place" TEXT,
  "eta_at" TIMESTAMP(3),
  "status" TEXT,
  "note" TEXT,
  "spoke_with" TEXT,
  "logged_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "check_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "check_calls_vehicle_id_at_idx" ON "check_calls"("vehicle_id", "at" DESC);
CREATE INDEX "check_calls_trailer_id_at_idx" ON "check_calls"("trailer_id", "at" DESC);
CREATE INDEX "check_calls_load_id_at_idx" ON "check_calls"("load_id", "at");
CREATE INDEX "check_calls_workspace_id_at_idx" ON "check_calls"("workspace_id", "at");
ALTER TABLE "check_calls" ADD CONSTRAINT "check_calls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "check_calls" ADD CONSTRAINT "check_calls_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "check_calls" ADD CONSTRAINT "check_calls_trailer_id_fkey" FOREIGN KEY ("trailer_id") REFERENCES "trailers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "check_calls" ADD CONSTRAINT "check_calls_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "unit_stays" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "vehicle_id" TEXT NOT NULL,
  "lat" DECIMAL(9,6) NOT NULL,
  "lng" DECIMAL(9,6) NOT NULL,
  "arrived_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "left_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "unit_stays_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "unit_stays_vehicle_id_arrived_at_idx" ON "unit_stays"("vehicle_id", "arrived_at" DESC);
CREATE INDEX "unit_stays_workspace_id_arrived_at_idx" ON "unit_stays"("workspace_id", "arrived_at");
ALTER TABLE "unit_stays" ADD CONSTRAINT "unit_stays_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_stays" ADD CONSTRAINT "unit_stays_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "trailer_moves" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "trailer_id" TEXT NOT NULL,
  "vehicle_id" TEXT,
  "kind" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL,
  "lat" DECIMAL(9,6),
  "lng" DECIMAL(9,6),
  "by_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trailer_moves_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "trailer_moves_trailer_id_at_idx" ON "trailer_moves"("trailer_id", "at" DESC);
CREATE INDEX "trailer_moves_vehicle_id_at_idx" ON "trailer_moves"("vehicle_id", "at" DESC);
ALTER TABLE "trailer_moves" ADD CONSTRAINT "trailer_moves_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trailer_moves" ADD CONSTRAINT "trailer_moves_trailer_id_fkey" FOREIGN KEY ("trailer_id") REFERENCES "trailers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trailer_moves" ADD CONSTRAINT "trailer_moves_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
