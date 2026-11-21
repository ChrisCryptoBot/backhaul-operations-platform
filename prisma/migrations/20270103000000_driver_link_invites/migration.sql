-- Phase 2 step 1 (driver link identity): a single-use, expiring invite code per driver. Only the code's sha256 is stored; the phone claims it on the bridge
-- (bridge.claim_driver_link in the phone project) and the desk's pull fills drivers.phone_user_id and workspaces.bridge_org_id.
CREATE TABLE "driver_link_invites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "driver_role" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "bridge_link_id" TEXT,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "ended_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_link_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "driver_link_invites_code_hash_key" ON "driver_link_invites"("code_hash");
CREATE INDEX "driver_link_invites_workspace_id_driver_id_created_at_idx" ON "driver_link_invites"("workspace_id", "driver_id", "created_at");

ALTER TABLE "driver_link_invites" ADD CONSTRAINT "driver_link_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_link_invites" ADD CONSTRAINT "driver_link_invites_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
