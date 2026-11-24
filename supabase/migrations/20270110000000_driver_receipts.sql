-- Generated from prisma/migrations/20270110000000_driver_receipts/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Sync plan Step 5b: money a driver spent on the job and asked for, from their phone. The desk keeps the record and the photo; an approved one goes on the driver's next statement.
CREATE TABLE IF NOT EXISTS "driver_receipts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "bridge_id" TEXT NOT NULL,
  "load_id" TEXT,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "spent_on" DATE NOT NULL,
  "note" TEXT,
  "state" TEXT NOT NULL DEFAULT 'submitted',
  "reason" TEXT,
  "decided_by" TEXT,
  "decided_at" TIMESTAMP(3),
  "settlement_id" TEXT,
  "storage_key" TEXT,
  "mime" TEXT,
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "photo_missing" TEXT,
  "sent_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_receipts_kind_check" CHECK ("kind" IN ('fuel', 'tolls', 'lumper', 'scale', 'parking', 'repair', 'other')),
  CONSTRAINT "driver_receipts_state_check" CHECK ("state" IN ('submitted', 'approved', 'declined')),
  CONSTRAINT "driver_receipts_amount_check" CHECK ("amount" > 0),
  -- Only an approved receipt is ever on a statement.
  CONSTRAINT "driver_receipts_settled_check" CHECK ("settlement_id" IS NULL OR "state" = 'approved'),
  CONSTRAINT "driver_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_receipts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "driver_receipts_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "driver_receipts_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "driver_receipts_bridge_id_key" ON "driver_receipts"("bridge_id");
CREATE INDEX IF NOT EXISTS "driver_receipts_workspace_id_state_idx" ON "driver_receipts"("workspace_id", "state");
CREATE INDEX IF NOT EXISTS "driver_receipts_driver_id_state_idx" ON "driver_receipts"("driver_id", "state");
CREATE INDEX IF NOT EXISTS "driver_receipts_settlement_id_idx" ON "driver_receipts"("settlement_id");
