-- Generated from prisma/migrations/20270114000000_ops_freight_claims_customer/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

ALTER TABLE "loads"
  ADD COLUMN "rate_con_number" TEXT,
  ADD COLUMN "pro_number" TEXT,
  ADD COLUMN "piece_count" INTEGER,
  ADD COLUMN "pallet_count" INTEGER,
  ADD COLUMN "bol_number" TEXT,
  ADD COLUMN "commodity" TEXT,
  ADD COLUMN "reefer_set_temp_f" DECIMAL(6,1),
  ADD COLUMN "reefer_min_f" DECIMAL(6,1),
  ADD COLUMN "reefer_max_f" DECIMAL(6,1),
  ADD COLUMN "reefer_mode" TEXT,
  ADD COLUMN "hazmat_un_number" TEXT,
  ADD COLUMN "hazmat_packing_group" TEXT,
  ADD COLUMN "hazmat_emergency_phone" TEXT,
  ADD COLUMN "customer_id" TEXT,
  ADD COLUMN "billed_extras" JSONB;

CREATE TABLE "load_claims" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "pieces" INTEGER,
  "amount" DECIMAL(12,2),
  "claimant" TEXT,
  "external_number" TEXT,
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ack_by" TIMESTAMP(3) NOT NULL,
  "decide_by" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "load_claims_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "loads_workspace_id_customer_id_idx" ON "loads"("workspace_id", "customer_id");
CREATE INDEX "loads_workspace_id_rate_con_number_idx" ON "loads"("workspace_id", "rate_con_number");
CREATE INDEX "loads_workspace_id_pro_number_idx" ON "loads"("workspace_id", "pro_number");
CREATE INDEX "load_claims_workspace_id_load_id_idx" ON "load_claims"("workspace_id", "load_id");
CREATE INDEX "load_claims_workspace_id_status_ack_by_idx" ON "load_claims"("workspace_id", "status", "ack_by");

ALTER TABLE "loads"
  ADD CONSTRAINT "loads_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "load_claims"
  ADD CONSTRAINT "load_claims_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "load_claims"
  ADD CONSTRAINT "load_claims_load_id_fkey"
  FOREIGN KEY ("load_id") REFERENCES "loads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "loads" l
SET "customer_id" = sub.id
FROM (
  SELECT DISTINCT ON ("workspace_id", lower(trim("name"))) "id", "workspace_id", lower(trim("name")) AS k
  FROM "customers"
  ORDER BY "workspace_id", lower(trim("name")), "created_at" ASC, "id" ASC
) sub
WHERE l."customer_id" IS NULL
  AND l."broker_name" IS NOT NULL
  AND trim(l."broker_name") <> ''
  AND l."workspace_id" = sub."workspace_id"
  AND lower(trim(l."broker_name")) = sub.k;
