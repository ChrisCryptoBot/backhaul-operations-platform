-- Generated from prisma/migrations/20261218000000_driver_deductions/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Recurring deductions and escrow (docs/MONEY_PLAN.md, Wave 4 step 3, rule K). Additive.
--   driver_deductions: what comes off a contractor's statement each time (lease, insurance, ELD, escrow, other), with an optional goal (escrow) or cap (the rest), and the dates it runs.
--   driver_ledger_entries: one ledger per driver for what was taken and what is held for them. Written in the finalize transaction, one row per deduction, escrow or escrow-release line
--   of that statement, signed as on the statement (money off negative, a release positive). Voiding the statement removes the rows it made. Escrow is the driver's money (a liability).
--   settlements.deduction_choices: a draft's choices (a deduction skipped with its reason, an escrow release with its reason).
--   settlement_lines.deduction_id: the rule a deduction or escrow row came from.

CREATE TABLE "driver_deductions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "goal" DECIMAL(12,2),
  "starts_on" DATE,
  "ends_on" DATE,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "driver_deductions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_deductions_kind_check" CHECK ("kind" IN ('lease', 'insurance', 'eld', 'escrow', 'other')),
  CONSTRAINT "driver_deductions_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "driver_deductions_goal_check" CHECK ("goal" IS NULL OR "goal" > 0)
);
CREATE INDEX "driver_deductions_workspace_id_driver_id_active_idx" ON "driver_deductions"("workspace_id", "driver_id", "active");
ALTER TABLE "driver_deductions" ADD CONSTRAINT "driver_deductions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_deductions" ADD CONSTRAINT "driver_deductions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "driver_ledger_entries" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "deduction_id" TEXT,
  "settlement_id" TEXT,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "driver_ledger_entries_kind_check" CHECK ("kind" IN ('deduction', 'escrow', 'escrow_release')),
  CONSTRAINT "driver_ledger_entries_sign_check" CHECK (("kind" = 'escrow_release' AND "amount" > 0) OR ("kind" <> 'escrow_release' AND "amount" < 0))
);
CREATE INDEX "driver_ledger_entries_workspace_id_driver_id_idx" ON "driver_ledger_entries"("workspace_id", "driver_id");
CREATE INDEX "driver_ledger_entries_deduction_id_idx" ON "driver_ledger_entries"("deduction_id");
CREATE INDEX "driver_ledger_entries_settlement_id_idx" ON "driver_ledger_entries"("settlement_id");
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_deduction_id_fkey" FOREIGN KEY ("deduction_id") REFERENCES "driver_deductions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "driver_ledger_entries" ADD CONSTRAINT "driver_ledger_entries_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "settlements" ADD COLUMN "deduction_choices" JSONB;
ALTER TABLE "settlement_lines" ADD COLUMN "deduction_id" TEXT;
