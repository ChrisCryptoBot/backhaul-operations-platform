-- The driver link (docs/DRIVER_LINK_DESIGN.md): which Clerk Organization a workspace is mapped to on the bridge, where the last pull ended, each driver's own phone account,
-- the bridge state of each assignment, and the outbox of what still has to be told to a phone. Everything is nullable or defaulted: a workspace that is not bridged is unchanged.
ALTER TABLE "workspaces" ADD COLUMN "bridge_org_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "bridge_cursor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "drivers" ADD COLUMN "phone_user_id" TEXT;
CREATE UNIQUE INDEX "drivers_workspace_id_phone_user_id_key" ON "drivers"("workspace_id", "phone_user_id");
ALTER TABLE "assignments" ADD COLUMN "bridge_dispatch_id" TEXT;
ALTER TABLE "assignments" ADD COLUMN "bridge_execution_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assignments" ADD COLUMN "bridge_synced_at" TIMESTAMP(3);
ALTER TABLE "assignments" ADD COLUMN "bridge_error" TEXT;

CREATE TABLE "bridge_outbox" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "phone_user_id" TEXT NOT NULL,
  "dispatch_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "done_at" TIMESTAMP(3),
  CONSTRAINT "bridge_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bridge_outbox_workspace_id_status_next_attempt_at_idx" ON "bridge_outbox"("workspace_id", "status", "next_attempt_at");
CREATE INDEX "bridge_outbox_load_id_idx" ON "bridge_outbox"("load_id");
ALTER TABLE "bridge_outbox" ADD CONSTRAINT "bridge_outbox_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
