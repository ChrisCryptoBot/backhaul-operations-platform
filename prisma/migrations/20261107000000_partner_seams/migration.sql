-- Wave E4: the places a partner company's answers will be kept, and the plan a workspace is on. Nothing writes them until a company is connected.

ALTER TABLE "loads" ADD COLUMN "factoring_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "loads" ADD COLUMN "factoring_reference_id" TEXT;
ALTER TABLE "loads" ADD COLUMN "factoring_updated_at" TIMESTAMP(3);

ALTER TABLE "vehicles" ADD COLUMN "eld_provider" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "vehicles" ADD COLUMN "eld_vehicle_id" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "hos_available_hours" DECIMAL(5,2);
ALTER TABLE "vehicles" ADD COLUMN "hos_synced_at" TIMESTAMP(3);

ALTER TABLE "cost_profiles" ADD COLUMN "fuel_card_provider" TEXT;
ALTER TABLE "cost_profiles" ADD COLUMN "fuel_card_account_id" TEXT;

ALTER TABLE "drivers" ADD COLUMN "payroll_employee_id" TEXT;
ALTER TABLE "drivers" ADD COLUMN "payroll_status" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "drivers" ADD COLUMN "payroll_worker_type" TEXT;
ALTER TABLE "drivers" ADD COLUMN "carrier_mc_number" TEXT;
ALTER TABLE "drivers" ADD COLUMN "carrier_dot_number" TEXT;
ALTER TABLE "drivers" ADD COLUMN "vet_status" TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE "drivers" ADD COLUMN "coi_expires_at" TIMESTAMP(3);
ALTER TABLE "drivers" ADD COLUMN "vet_checked_at" TIMESTAMP(3);

ALTER TABLE "settlements" ADD COLUMN "payroll_sent_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN "payroll_reference" TEXT;

-- The plan, or none chosen yet (then the price follows the fleet's size and nothing is limited).
ALTER TABLE "workspaces" ADD COLUMN "plan" TEXT;

CREATE TABLE "partner_connections" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "account_label" TEXT,
  "last_error" TEXT,
  "connected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_connections_workspace_id_capability_provider_key" ON "partner_connections"("workspace_id", "capability", "provider");
ALTER TABLE "partner_connections" ADD CONSTRAINT "partner_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
