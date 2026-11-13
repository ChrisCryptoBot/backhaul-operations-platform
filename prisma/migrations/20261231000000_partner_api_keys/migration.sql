-- Money plan Wave 7 step 2: keys for the partner read API. Only the SHA-256 of a key is stored; the key is shown once when it is made. The rate window lives on the row so every server
-- instance shares one count.
CREATE TABLE "partner_api_keys" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "window_start" TIMESTAMP(3),
    "window_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "partner_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partner_api_keys_prefix_key" ON "partner_api_keys"("prefix");
CREATE INDEX "partner_api_keys_workspace_id_created_at_idx" ON "partner_api_keys"("workspace_id", "created_at");

ALTER TABLE "partner_api_keys" ADD CONSTRAINT "partner_api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
