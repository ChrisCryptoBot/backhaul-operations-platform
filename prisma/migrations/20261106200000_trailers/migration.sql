-- Wave E2: the trailer registry. A trailer is a unit with its own number, plate, compliance dates and place: owned, leased, a customer's or a pool trailer.
-- It is hooked to at most one tractor (a trailer a tractor at a time) and can be put on a load.

CREATE TABLE "trailers" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "type" TEXT,
  "plate" TEXT,
  "plate_state" TEXT,
  "vin" TEXT,
  "ownership" TEXT NOT NULL DEFAULT 'owned',
  "length_ft" DECIMAL(8,2),
  "width_in" DECIMAL(8,2),
  "tare_lbs" INTEGER,
  "max_payload_lbs" INTEGER,
  "axles" INTEGER,
  "has_liftgate" BOOLEAN NOT NULL DEFAULT false,
  "has_e_track" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'available',
  "terminal" TEXT,
  "location" TEXT,
  "current_vehicle_id" TEXT,
  "registration_expiry" TIMESTAMP(3),
  "inspection_expiry" TIMESTAMP(3),
  "notes" TEXT,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trailers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trailers_workspace_id_archived_at_number_idx" ON "trailers"("workspace_id", "archived_at", "number");
CREATE INDEX "trailers_workspace_id_terminal_idx" ON "trailers"("workspace_id", "terminal");
CREATE INDEX "trailers_workspace_id_status_idx" ON "trailers"("workspace_id", "status");
CREATE INDEX "trailers_current_vehicle_id_idx" ON "trailers"("current_vehicle_id");

-- One number per workspace among the trailers in service, whatever the capitalisation; a tractor pulls one trailer at a time.
CREATE UNIQUE INDEX "trailers_workspace_number_key" ON "trailers" ("workspace_id", lower("number")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "trailers_one_per_tractor_key" ON "trailers" ("current_vehicle_id") WHERE "current_vehicle_id" IS NOT NULL AND "archived_at" IS NULL;

ALTER TABLE "trailers" ADD CONSTRAINT "trailers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trailers" ADD CONSTRAINT "trailers_current_vehicle_id_fkey" FOREIGN KEY ("current_vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Search by number, plate and VIN.
CREATE INDEX "trailers_number_trgm_idx" ON "trailers" USING gin ("number" gin_trgm_ops);
CREATE INDEX "trailers_plate_trgm_idx" ON "trailers" USING gin ("plate" gin_trgm_ops);
CREATE INDEX "trailers_vin_trgm_idx" ON "trailers" USING gin ("vin" gin_trgm_ops);

-- The trailer on a load.
ALTER TABLE "loads" ADD COLUMN "trailer_id" TEXT;
CREATE INDEX "loads_trailer_id_idx" ON "loads"("trailer_id");
ALTER TABLE "loads" ADD CONSTRAINT "loads_trailer_id_fkey" FOREIGN KEY ("trailer_id") REFERENCES "trailers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A record's history is found by its id, not by matching words in a summary.
ALTER TABLE "audit_events" ADD COLUMN "entity_id" TEXT;
CREATE INDEX "audit_events_entity_id_created_at_idx" ON "audit_events"("entity_id", "created_at");
