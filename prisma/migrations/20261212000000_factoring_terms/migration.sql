-- Factoring terms and economics (docs/MONEY_PLAN.md, Wave 2). Additive. A fleet's own factoring terms (where a factored invoice must be paid, the notice of assignment, and the
-- advance and fee the factor charges), and the money of a factored invoice kept on the invoice record: what was advanced, the fee, the reserve held and released, and any chargeback.

CREATE TABLE "factoring_terms" (
  "workspace_id" TEXT NOT NULL,
  "factor_name" TEXT,
  "remit_name" TEXT,
  "remit_address" TEXT,
  "lockbox_bank" TEXT,
  "routing_number" TEXT,
  "account_number" TEXT,
  "noa_text" TEXT,
  "advance_pct" DECIMAL(5,2),
  "fee_pct" DECIMAL(5,2),
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "factoring_terms_pkey" PRIMARY KEY ("workspace_id")
);
ALTER TABLE "factoring_terms" ADD CONSTRAINT "factoring_terms_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoices" ADD COLUMN "factoring_advance" DECIMAL(12,2);
ALTER TABLE "invoices" ADD COLUMN "factoring_fee" DECIMAL(12,2);
ALTER TABLE "invoices" ADD COLUMN "factoring_reserve" DECIMAL(12,2);
ALTER TABLE "invoices" ADD COLUMN "factoring_reserve_released" DECIMAL(12,2);
ALTER TABLE "invoices" ADD COLUMN "factoring_chargeback" DECIMAL(12,2);
ALTER TABLE "invoices" ADD COLUMN "noa_applied_at" TIMESTAMP(3);
