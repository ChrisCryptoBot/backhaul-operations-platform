-- Who held a load, when, and why it changed hands (docs/RELAY_DESIGN.md). Additive: one new table, nothing existing is touched, nothing is seeded or backfilled.
-- load_id is a plain column (no foreign key) so the trail outlives a deleted load, as audit_events does.

CREATE TABLE "assignment_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "load_number" TEXT,
  "kind" TEXT NOT NULL,
  "driver_id" TEXT,
  "driver_name" TEXT,
  "reason_code" TEXT,
  "reason_note" TEXT,
  "actor" TEXT NOT NULL DEFAULT 'Dispatcher',
  "via" TEXT NOT NULL DEFAULT 'dispatcher',
  "assignment_version" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assignment_events_kind_check" CHECK ("kind" IN ('assigned', 'reassigned', 'sent', 'accepted', 'declined', 'recalled', 'removed')),
  CONSTRAINT "assignment_events_via_check" CHECK ("via" IN ('dispatcher', 'phone')),
  CONSTRAINT "assignment_events_reason_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('ASSIGNED_IN_ERROR', 'HOS_TIMEOUT', 'MECHANICAL_BREAKDOWN', 'DRIVER_UNRESPONSIVE', 'SCHEDULED_RELAY'))
);
CREATE INDEX "assignment_events_load_id_created_at_idx" ON "assignment_events"("load_id", "created_at");
CREATE INDEX "assignment_events_workspace_id_kind_created_at_idx" ON "assignment_events"("workspace_id", "kind", "created_at");
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
