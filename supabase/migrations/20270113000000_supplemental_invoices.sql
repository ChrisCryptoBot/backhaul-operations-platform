-- Generated from prisma/migrations/20270113000000_supplemental_invoices/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

ALTER TABLE "invoices"
  ADD COLUMN "supplement_of_id" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_supplement_of_id_fkey"
  FOREIGN KEY ("supplement_of_id") REFERENCES "invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "invoices_workspace_id_supplement_of_id_idx"
  ON "invoices"("workspace_id", "supplement_of_id");
