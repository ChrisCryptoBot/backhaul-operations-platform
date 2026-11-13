-- Generated from prisma/migrations/20261222000000_fuel_import_batch/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Fuel CSV import (docs/MONEY_PLAN.md, Wave 5 step 2). Additive.
--   import_batch_id: the CSV import that brought a purchase in (provider 'csv'), so a whole file can be taken away again. Null for a purchase read from a card company.
--   A purchase from a file is kept once by (workspace, provider, external_id) like any other: the file's own transaction id when it has one, else a key made from the row.

ALTER TABLE "fuel_transactions" ADD COLUMN "import_batch_id" TEXT;
CREATE INDEX "fuel_transactions_workspace_id_import_batch_id_idx" ON "fuel_transactions"("workspace_id", "import_batch_id");
