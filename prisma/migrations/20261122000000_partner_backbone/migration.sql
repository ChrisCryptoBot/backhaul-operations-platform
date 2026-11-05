-- The partner backbone (docs/PARTNER_BACKBONE.md): a connection's health and webhook address, a fleet's own encrypted keys, and the events a company's webhook has sent.
ALTER TABLE "partner_connections" ADD COLUMN "last_synced_at" TIMESTAMP(3);
ALTER TABLE "partner_connections" ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "partner_connections" ADD COLUMN "next_sync_at" TIMESTAMP(3);
ALTER TABLE "partner_connections" ADD COLUMN "webhook_token" TEXT;
CREATE UNIQUE INDEX "partner_connections_webhook_token_key" ON "partner_connections"("webhook_token");

CREATE TABLE "partner_credentials" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "sealed" TEXT NOT NULL,
  "hints" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_credentials_workspace_id_provider_key" ON "partner_credentials"("workspace_id", "provider");
ALTER TABLE "partner_credentials" ADD CONSTRAINT "partner_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "partner_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "detail" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_events_provider_event_id_key" ON "partner_events"("provider", "event_id");
CREATE INDEX "partner_events_workspace_id_received_at_idx" ON "partner_events"("workspace_id", "received_at");
ALTER TABLE "partner_events" ADD CONSTRAINT "partner_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
