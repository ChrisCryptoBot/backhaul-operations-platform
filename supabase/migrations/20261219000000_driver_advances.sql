-- Generated from prisma/migrations/20261219000000_driver_advances/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Advances (docs/MONEY_PLAN.md, Wave 4 step 4). Additive, plus two widened checks on the ledger.
--   driver_advances: money given to a contractor ahead of their pay (cash, check, transfer, fuel card, other), on a day, repaid by a set amount per statement until it is cleared.
--   driver_ledger_entries.advance_id: recording an advance writes an 'advance' entry (positive: money given); each statement that repays it writes an 'advance_repaid' entry (negative), tied to
--   that statement so voiding it removes exactly that repayment. What is owed on an advance is the sum of its entries, never below zero and never above the advance.
--   settlement_lines.advance_id: the advance a repayment row came from.

CREATE TABLE "driver_advances" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "given_on" DATE NOT NULL,
  "method" TEXT NOT NULL,
  "repay_amount" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "driver_advances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_advances_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "driver_advances_repay_check" CHECK ("repay_amount" > 0 AND "repay_amount" <= "amount"),
  CONSTRAINT "driver_advances_method_check" CHECK ("method" IN ('cash', 'check', 'transfer', 'fuel_card', 'other'))
);
CREATE INDEX "driver_advances_workspace_id_driver_id_active_idx" ON "driver_advances"("workspace_id", "driver_id", "active");
ALTER TABLE "driver_advances" ADD CONSTRAINT "driver_advances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_advances" ADD CONSTRAINT "driver_advances_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "driver_ledger_entries" ADD COLUMN "advance_id" TEXT;
CREATE INDEX "driver_ledger_entries_advance_id_idx" ON "driver_ledger_entries"("advance_id");
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_advance_id_fkey" FOREIGN KEY ("advance_id") REFERENCES "driver_advances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "driver_ledger_entries" DROP CONSTRAINT "driver_ledger_entries_kind_check";
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_kind_check" CHECK ("kind" IN ('deduction', 'escrow', 'escrow_release', 'advance', 'advance_repaid'));
ALTER TABLE "driver_ledger_entries" DROP CONSTRAINT "driver_ledger_entries_sign_check";
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_sign_check" CHECK (("kind" IN ('escrow_release', 'advance') AND "amount" > 0) OR ("kind" NOT IN ('escrow_release', 'advance') AND "amount" < 0));
-- An advance entry and a repayment entry always name their advance.
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_advance_check" CHECK (("kind" IN ('advance', 'advance_repaid')) = ("advance_id" IS NOT NULL));

ALTER TABLE "settlement_lines" ADD COLUMN "advance_id" TEXT;
