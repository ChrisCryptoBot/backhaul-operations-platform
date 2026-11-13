-- Accounting accounts (docs/MONEY_PLAN.md, Wave 3, step 2; rules D and E). Additive. A fleet's own names for the accounts its money is booked to: one per invoice line kind (income),
-- per expense (1099 driver pay, fuel, factoring fees, write-offs) and per balance account (receivables, cash, the factor's reserve, payables). A kind with no row uses the default name;
-- a kind with no default and no row is unmapped, and a sync or a journal that needs it stops before anything is sent.
-- An invoice also keeps when the factor funded it, so the journal dates the advance on the day it was paid, not the day of the latest factoring change.

CREATE TABLE "accounting_accounts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "number" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "accounting_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "accounting_accounts_workspace_id_key_key" ON "accounting_accounts"("workspace_id", "key");
ALTER TABLE "accounting_accounts" ADD CONSTRAINT "accounting_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoices" ADD COLUMN "factoring_funded_at" TIMESTAMP(3);
-- Before this column, the latest factoring change is the best date there is for an invoice the factor funded (or that was funded and then charged back).
UPDATE "invoices" SET "factoring_funded_at" = "factoring_updated_at"
WHERE "factoring_funded_at" IS NULL AND ("factoring_status" IN ('funded', 'paid') OR "factoring_chargeback" IS NOT NULL) AND "factoring_advance" IS NOT NULL;
