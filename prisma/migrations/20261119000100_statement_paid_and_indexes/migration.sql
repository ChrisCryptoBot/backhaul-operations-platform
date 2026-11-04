-- Driver statements: when and how the driver was paid (a statement paid, through payroll or not, cannot be voided), a counter so a discarded number is never reused, and the indexes the
-- receivables and statements lists sort by.
ALTER TABLE "settlements" ADD COLUMN "paid_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN "paid_method" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "settlement_seq" INTEGER NOT NULL DEFAULT 0;
UPDATE "workspaces" w SET "settlement_seq" = COALESCE((SELECT MAX(NULLIF(regexp_replace(s."number", '\D', '', 'g'), '')::int) FROM "settlements" s WHERE s."workspace_id" = w."id"), 0);
CREATE INDEX "settlements_workspace_id_created_at_idx" ON "settlements"("workspace_id", "created_at");
CREATE INDEX "settlements_workspace_id_finalized_at_idx" ON "settlements"("workspace_id", "finalized_at");
CREATE INDEX "loads_workspace_id_payment_status_invoiced_at_idx" ON "loads"("workspace_id", "payment_status", "invoiced_at");
