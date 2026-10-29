-- The company on invoices and statements, and how a payment came in.
ALTER TABLE "workspaces" ADD COLUMN "mc_number" TEXT,
ADD COLUMN "dot_number" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "email" TEXT,
ADD COLUMN "remit_to" TEXT,
ADD COLUMN "payment_note" TEXT;

ALTER TABLE "loads" ADD COLUMN "paid_method" TEXT;

-- An invoice number belongs to one live load in a workspace. The form checks this first; this is what holds when two people save at once.
CREATE UNIQUE INDEX "loads_workspace_invoice_number_key" ON "loads" ("workspace_id", "invoice_number") WHERE "invoice_number" IS NOT NULL AND "deleted_at" IS NULL;
