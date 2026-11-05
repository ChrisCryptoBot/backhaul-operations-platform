-- What the partner adapters produce, kept so a screen can show it (docs/PARTNER_BACKBONE.md): a load's tracking link, a carrier check's score and reasons, and fuel card purchases.
ALTER TABLE "loads" ADD COLUMN "tracking_share_url" TEXT,
ADD COLUMN "tracking_provider" TEXT,
ADD COLUMN "tracking_shared_at" TIMESTAMP(3);

ALTER TABLE "drivers" ADD COLUMN "vet_safety_score" INTEGER,
ADD COLUMN "vet_authority_active" BOOLEAN,
ADD COLUMN "vet_flags" JSONB;

CREATE TABLE "fuel_transactions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "vehicle_id" TEXT,
  "load_id" TEXT,
  "posted_at" TIMESTAMP(3) NOT NULL,
  "location" TEXT,
  "gallons" DECIMAL(10,3),
  "price_per_gallon" DECIMAL(8,4),
  "discount_per_gallon" DECIMAL(8,4),
  "discount" DECIMAL(12,2),
  "amount" DECIMAL(12,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fuel_transactions_workspace_id_provider_external_id_key" ON "fuel_transactions"("workspace_id", "provider", "external_id");
CREATE INDEX "fuel_transactions_workspace_id_posted_at_idx" ON "fuel_transactions"("workspace_id", "posted_at");
CREATE INDEX "fuel_transactions_load_id_idx" ON "fuel_transactions"("load_id");
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
