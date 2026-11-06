-- The detention evidence pack (docs/DETENTION_EVIDENCE.md): what a truck's own track says about one stop, frozen when the load is delivered, because the position fixes are deleted after a week and a
-- detention claim is made weeks later. A proposal changes nothing; a person confirms it. One row per stop. Seeds nothing.

CREATE TABLE "stop_evidence" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "stop_id" TEXT NOT NULL,
  "vehicle_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'proposed',
  "quality" TEXT NOT NULL,
  "radius_miles" DECIMAL(5,3) NOT NULL,
  "fixes" JSONB NOT NULL,
  "fix_count" INTEGER NOT NULL,
  "inside_count" INTEGER NOT NULL,
  "window_start" TIMESTAMP(3),
  "window_end" TIMESTAMP(3),
  "proposed_arrival_at" TIMESTAMP(3),
  "proposed_departure_at" TIMESTAMP(3),
  "before_gap_min" INTEGER,
  "after_gap_min" INTEGER,
  "still_inside" BOOLEAN NOT NULL DEFAULT false,
  "visit_count" INTEGER NOT NULL DEFAULT 0,
  "wait_from" TIMESTAMP(3),
  "proposed_wait_minutes" INTEGER,
  "sha256" TEXT NOT NULL,
  "frozen_at" TIMESTAMP(3) NOT NULL,
  "decided_by" TEXT,
  "decided_at" TIMESTAMP(3),
  "confirmed_arrival_at" TIMESTAMP(3),
  "confirmed_wait_minutes" INTEGER,
  "edited" BOOLEAN NOT NULL DEFAULT false,
  "wrote_to_stop" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stop_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stop_evidence_state_check" CHECK ("state" IN ('proposed', 'confirmed', 'dismissed')),
  CONSTRAINT "stop_evidence_quality_check" CHECK ("quality" IN ('good', 'thin', 'none'))
);
CREATE UNIQUE INDEX "stop_evidence_stop_id_key" ON "stop_evidence"("stop_id");
CREATE INDEX "stop_evidence_workspace_id_state_idx" ON "stop_evidence"("workspace_id", "state");
CREATE INDEX "stop_evidence_load_id_idx" ON "stop_evidence"("load_id");
ALTER TABLE "stop_evidence" ADD CONSTRAINT "stop_evidence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stop_evidence" ADD CONSTRAINT "stop_evidence_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stop_evidence" ADD CONSTRAINT "stop_evidence_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stop_evidence" ADD CONSTRAINT "stop_evidence_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
