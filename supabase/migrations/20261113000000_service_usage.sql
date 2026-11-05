-- Generated from prisma/migrations/20261113000000_service_usage/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Spend guardrails: the desk's ledger of paid calls (rate-confirmation reads, Mapbox calls). A claim is written before the paid call and removed if it never happened.

CREATE TABLE "service_usage" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 1,
  "est_cents" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_usage_service_created_at_idx" ON "service_usage"("service", "created_at");
CREATE INDEX "service_usage_workspace_id_service_created_at_idx" ON "service_usage"("workspace_id", "service", "created_at");
