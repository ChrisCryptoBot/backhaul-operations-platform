-- Generated from prisma/migrations/20261209000000_relay_legs_handoffs/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Relays (docs/RELAY_DESIGN.md, phase 2): the legs of a load and the baton handed between them. Additive: two new tables, and the holder-trail's list of kinds gains two.
-- A load with no relay has no rows here. Nothing is seeded or backfilled.

CREATE TABLE "load_legs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'haul',
  "status" TEXT NOT NULL DEFAULT 'active',
  "driver_id" TEXT,
  "driver_name" TEXT,
  "vehicle_id" TEXT,
  "vehicle_name" TEXT,
  "trailer_id" TEXT,
  "trailer_number" TEXT,
  "from_name" TEXT,
  "from_lat" DECIMAL(9,6),
  "from_lng" DECIMAL(9,6),
  "to_name" TEXT,
  "to_lat" DECIMAL(9,6),
  "to_lng" DECIMAL(9,6),
  "started_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "miles_driven" DECIMAL(10,1),
  "miles_source" TEXT,
  "pay_kind" TEXT,
  "pay_rate" DECIMAL(12,4),
  "pay_estimate" DECIMAL(12,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "load_legs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "load_legs_kind_check" CHECK ("kind" IN ('haul', 'positioning')),
  CONSTRAINT "load_legs_status_check" CHECK ("status" IN ('active', 'closed')),
  CONSTRAINT "load_legs_miles_source_check" CHECK ("miles_source" IS NULL OR "miles_source" IN ('eld', 'driver', 'dispatcher')),
  CONSTRAINT "load_legs_miles_have_source_check" CHECK ("miles_driven" IS NULL OR "miles_source" IS NOT NULL)
);
CREATE UNIQUE INDEX "load_legs_load_id_seq_key" ON "load_legs"("load_id", "seq");
CREATE INDEX "load_legs_workspace_id_load_id_idx" ON "load_legs"("workspace_id", "load_id");
ALTER TABLE "load_legs" ADD CONSTRAINT "load_legs_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "load_legs" ADD CONSTRAINT "load_legs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "handoffs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'dropped',
  "out_leg_seq" INTEGER NOT NULL,
  "in_leg_seq" INTEGER,
  "location_name" TEXT,
  "location_lat" DECIMAL(9,6),
  "location_lng" DECIMAL(9,6),
  "location_slot" TEXT,
  "location_set_by" TEXT NOT NULL DEFAULT 'dispatcher_typed',
  "tractor_out_id" TEXT,
  "tractor_out_name" TEXT,
  "tractor_in_id" TEXT,
  "tractor_in_name" TEXT,
  "trailer_id" TEXT,
  "trailer_number" TEXT,
  "out_driver_id" TEXT,
  "out_driver_name" TEXT,
  "in_driver_id" TEXT,
  "in_driver_name" TEXT,
  "seal_number" TEXT,
  "seal_matches" BOOLEAN,
  "reefer_set_temp" DECIMAL(6,1),
  "reefer_actual_temp" DECIMAL(6,1),
  "reefer_fuel_pct" INTEGER,
  "condition_ok" BOOLEAN,
  "condition_notes" TEXT,
  "discrepancy_flagged" BOOLEAN NOT NULL DEFAULT false,
  "discrepancy_notes" TEXT,
  "discrepancy_by" TEXT,
  "discrepancy_at" TIMESTAMP(3),
  "ack_by" TEXT,
  "ack_at" TIMESTAMP(3),
  "outgoing_next" TEXT,
  "dropped_at" TIMESTAMP(3) NOT NULL,
  "dropped_source" TEXT NOT NULL DEFAULT 'dispatcher',
  "received_at" TIMESTAMP(3),
  "received_source" TEXT,
  "entered_by" TEXT NOT NULL DEFAULT 'Dispatcher',
  "via" TEXT NOT NULL DEFAULT 'dispatcher',
  "frozen_at" TIMESTAMP(3),
  "frozen_sha256" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "handoffs_type_check" CHECK ("type" IN ('drop_hook', 'rescue', 'slip_seat')),
  CONSTRAINT "handoffs_reason_check" CHECK ("reason" IN ('planned', 'hos', 'breakdown', 'recall_convert')),
  CONSTRAINT "handoffs_state_check" CHECK ("state" IN ('dropped', 'received', 'disputed')),
  CONSTRAINT "handoffs_location_set_by_check" CHECK ("location_set_by" IN ('planned_yard', 'emergency_pin', 'dispatcher_typed')),
  CONSTRAINT "handoffs_outgoing_next_check" CHECK ("outgoing_next" IS NULL OR "outgoing_next" IN ('bobtail', 'hook_empty', 'return_load', 'available_at_yard')),
  CONSTRAINT "handoffs_sources_check" CHECK ("dropped_source" IN ('driver', 'dispatcher', 'eld') AND ("received_source" IS NULL OR "received_source" IN ('driver', 'dispatcher')))
);
CREATE INDEX "handoffs_load_id_created_at_idx" ON "handoffs"("load_id", "created_at");
CREATE INDEX "handoffs_workspace_id_state_idx" ON "handoffs"("workspace_id", "state");
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The holder trail also records a handoff: the outgoing driver dropped it, the incoming driver received it.
ALTER TABLE "assignment_events" DROP CONSTRAINT "assignment_events_kind_check";
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_kind_check" CHECK ("kind" IN ('assigned', 'reassigned', 'sent', 'accepted', 'declined', 'recalled', 'removed', 'dropped', 'received'));
