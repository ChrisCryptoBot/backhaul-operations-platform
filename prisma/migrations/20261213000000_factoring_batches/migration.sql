-- Factoring by batch (docs/MONEY_PLAN.md, Wave 2). Additive. Most factors take invoices as a batch of files (a schedule of accounts and one PDF packet per invoice) by SFTP or email rather than
-- through an API. A fleet's terms say which way its factor takes them and where to; each batch sent is kept with its invoices, how many times it was tried, and why it last failed.

ALTER TABLE "factoring_terms" ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'api';
ALTER TABLE "factoring_terms" ADD COLUMN "batch_method" TEXT;
ALTER TABLE "factoring_terms" ADD COLUMN "batch_destination" TEXT;

CREATE TABLE "factoring_batches" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "method" TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "invoice_count" INTEGER NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "receipt" TEXT,
  "sent_at" TIMESTAMP(3),
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "factoring_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "factoring_batches_workspace_id_number_key" ON "factoring_batches"("workspace_id", "number");
CREATE INDEX "factoring_batches_workspace_id_created_at_idx" ON "factoring_batches"("workspace_id", "created_at");
ALTER TABLE "factoring_batches" ADD CONSTRAINT "factoring_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "factoring_batch_invoices" (
  "batch_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  CONSTRAINT "factoring_batch_invoices_pkey" PRIMARY KEY ("batch_id", "invoice_id")
);
CREATE INDEX "factoring_batch_invoices_invoice_id_idx" ON "factoring_batch_invoices"("invoice_id");
ALTER TABLE "factoring_batch_invoices" ADD CONSTRAINT "factoring_batch_invoices_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "factoring_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "factoring_batch_invoices" ADD CONSTRAINT "factoring_batch_invoices_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
