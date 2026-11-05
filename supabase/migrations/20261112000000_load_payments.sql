-- Generated from prisma/migrations/20261112000000_load_payments/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Payments received against an invoice, one row each, so an invoice can be paid in part and stay out with a balance. The load's paid_amount is their sum. Invoices already marked paid
-- keep their single paid_amount and have no rows here (taking such a payment back still works).

CREATE TABLE "load_payments" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "paid_at" TIMESTAMP(3) NOT NULL,
  "method" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "load_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "load_payments_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "load_payments_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "load_payments_load_id_idx" ON "load_payments"("load_id");
CREATE INDEX "load_payments_workspace_id_idx" ON "load_payments"("workspace_id");
