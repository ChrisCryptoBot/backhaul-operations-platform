-- Wave E1: a desk that serves a fleet of a thousand-odd tractors and tens of thousands of loads.
-- 1. Terminals: which yard / branch runs a truck or a driver (free text, nullable; the terminals offered are the distinct values in use).
-- 2. The btree indexes the paged lists, the shell counts and the KPI reads filter and sort by.
-- 3. Trigram indexes so a search box (`ilike '%text%'`) does not read every row.
-- Plain CREATE INDEX (a few seconds' write lock on a demo-sized table); a production roll-out of this would build them CONCURRENTLY, outside a transaction.

ALTER TABLE "vehicles" ADD COLUMN "terminal" TEXT;
ALTER TABLE "drivers" ADD COLUMN "terminal" TEXT;

-- Replaced by the wider indexes below (each new one starts with the old one's columns).
DROP INDEX IF EXISTS "loads_workspace_id_status_idx";
DROP INDEX IF EXISTS "loads_vehicle_id_idx";
DROP INDEX IF EXISTS "loads_completed_at_idx";
DROP INDEX IF EXISTS "vehicles_workspace_id_idx";
DROP INDEX IF EXISTS "drivers_workspace_id_idx";

CREATE INDEX "loads_workspace_id_deleted_at_status_idx" ON "loads"("workspace_id", "deleted_at", "status");
CREATE INDEX "loads_workspace_id_scheduled_date_idx" ON "loads"("workspace_id", "scheduled_date");
CREATE INDEX "loads_workspace_id_completed_at_idx" ON "loads"("workspace_id", "completed_at");
CREATE INDEX "loads_workspace_id_payment_status_idx" ON "loads"("workspace_id", "payment_status");
CREATE INDEX "loads_workspace_id_broker_name_idx" ON "loads"("workspace_id", "broker_name");
CREATE INDEX "loads_workspace_id_load_number_idx" ON "loads"("workspace_id", "load_number");
CREATE INDEX "loads_vehicle_id_status_idx" ON "loads"("vehicle_id", "status");

CREATE INDEX "vehicles_workspace_id_archived_at_name_idx" ON "vehicles"("workspace_id", "archived_at", "name");
CREATE INDEX "vehicles_workspace_id_terminal_idx" ON "vehicles"("workspace_id", "terminal");

CREATE INDEX "drivers_workspace_id_active_name_idx" ON "drivers"("workspace_id", "active", "name");
CREATE INDEX "drivers_workspace_id_terminal_idx" ON "drivers"("workspace_id", "terminal");
CREATE INDEX "drivers_assigned_vehicle_id_idx" ON "drivers"("assigned_vehicle_id");

CREATE INDEX "assignments_status_idx" ON "assignments"("status");

CREATE INDEX "audit_events_workspace_id_action_created_at_idx" ON "audit_events"("workspace_id", "action", "created_at");

-- Search. Not in schema.prisma (Prisma cannot express them); `migrate deploy` is how this database is built, as for customers' lower(name) index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "loads_load_number_trgm_idx" ON "loads" USING gin ("load_number" gin_trgm_ops);
CREATE INDEX "loads_po_number_trgm_idx" ON "loads" USING gin ("po_number" gin_trgm_ops);
CREATE INDEX "loads_invoice_number_trgm_idx" ON "loads" USING gin ("invoice_number" gin_trgm_ops);
CREATE INDEX "loads_broker_name_trgm_idx" ON "loads" USING gin ("broker_name" gin_trgm_ops);
CREATE INDEX "loads_broker_mc_number_trgm_idx" ON "loads" USING gin ("broker_mc_number" gin_trgm_ops);
CREATE INDEX "loads_origin_address_trgm_idx" ON "loads" USING gin ("origin_address" gin_trgm_ops);
CREATE INDEX "loads_destination_address_trgm_idx" ON "loads" USING gin ("destination_address" gin_trgm_ops);
CREATE INDEX "vehicles_name_trgm_idx" ON "vehicles" USING gin ("name" gin_trgm_ops);
CREATE INDEX "drivers_name_trgm_idx" ON "drivers" USING gin ("name" gin_trgm_ops);
CREATE INDEX "audit_events_summary_trgm_idx" ON "audit_events" USING gin ("summary" gin_trgm_ops);
