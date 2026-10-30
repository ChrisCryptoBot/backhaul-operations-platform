-- The people on a desk. Sign-in proves who someone is; this table says which workspace they work in and as what. Nothing reads it until DESK_AUTH is switched on.

CREATE TABLE "members" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'dispatcher',
  "clerk_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3),
  CONSTRAINT "members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "members_role_check" CHECK ("role" IN ('viewer', 'dispatcher', 'owner')),
  CONSTRAINT "members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "members_clerk_user_id_key" ON "members"("clerk_user_id");
CREATE UNIQUE INDEX "members_workspace_id_email_key" ON "members"("workspace_id", "email");
CREATE INDEX "members_email_idx" ON "members"("email");
