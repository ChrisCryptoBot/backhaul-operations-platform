-- Generated from prisma/migrations/20261214000000_accounting_oauth_sync/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Accounting sync groundwork (docs/MONEY_PLAN.md, Wave 3, step 1). Additive. A partner company that connects by OAuth 2 (QuickBooks Online first) keeps its tokens sealed per fleet;
-- a sign-in redirect is a one-time state; every desk record pushed to a company is mapped to the company's record, so a sync updates instead of creating twice; and each pull keeps a cursor.

CREATE TABLE "partner_oauth_tokens" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "sealed" TEXT NOT NULL,
  "scope" TEXT,
  "access_expires_at" TIMESTAMP(3) NOT NULL,
  "refresh_expires_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "refreshing_until" TIMESTAMP(3),
  "refreshed_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_error" TEXT,
  "connected_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_oauth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_oauth_tokens_workspace_id_provider_key" ON "partner_oauth_tokens"("workspace_id", "provider");
ALTER TABLE "partner_oauth_tokens" ADD CONSTRAINT "partner_oauth_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "partner_oauth_states" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "state_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_oauth_states_state_hash_key" ON "partner_oauth_states"("state_hash");
CREATE INDEX "partner_oauth_states_workspace_id_created_at_idx" ON "partner_oauth_states"("workspace_id", "created_at");
ALTER TABLE "partner_oauth_states" ADD CONSTRAINT "partner_oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "external_refs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "local_id" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "sync_token" TEXT,
  "pushed_hash" TEXT,
  "synced_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_refs_workspace_id_provider_entity_local_id_key" ON "external_refs"("workspace_id", "provider", "entity", "local_id");
CREATE UNIQUE INDEX "external_refs_workspace_id_provider_entity_external_id_key" ON "external_refs"("workspace_id", "provider", "entity", "external_id");
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sync_cursors" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "stream" TEXT NOT NULL,
  "cursor" TEXT,
  "last_run_at" TIMESTAMP(3),
  "last_ok_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sync_cursors_workspace_id_provider_stream_key" ON "sync_cursors"("workspace_id", "provider", "stream");
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
