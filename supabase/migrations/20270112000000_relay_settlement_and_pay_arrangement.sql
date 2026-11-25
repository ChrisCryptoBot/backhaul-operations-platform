-- Generated from prisma/migrations/20270112000000_relay_settlement_and_pay_arrangement/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Phase 3 (Relay settlement & lifecycle + 2026-11-24 Pay Arrangement Addendum):
-- 1) settlement_legs: one row per settled LoadLeg so relay legs pay per driver while loads.settlement stays singular.
-- 2) load_legs.miles_source adds 'remainder'; handoffs.state adds 'cancelled'.
-- 3) drivers.pay_arrangement and workspaces.{default_pay_arrangement, pay_miles_basis}.

CREATE TABLE "settlement_legs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "settlement_id" TEXT NOT NULL,
  "load_leg_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_legs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "settlement_legs_load_leg_id_key" ON "settlement_legs"("load_leg_id");
CREATE INDEX "settlement_legs_settlement_id_idx" ON "settlement_legs"("settlement_id");
CREATE INDEX "settlement_legs_load_id_idx" ON "settlement_legs"("load_id");

ALTER TABLE "settlement_legs" ADD CONSTRAINT "settlement_legs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "settlement_legs" ADD CONSTRAINT "settlement_legs_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "settlement_legs" ADD CONSTRAINT "settlement_legs_load_leg_id_fkey" FOREIGN KEY ("load_leg_id") REFERENCES "load_legs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_legs" ADD CONSTRAINT "settlement_legs_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "load_legs" DROP CONSTRAINT "load_legs_miles_source_check";
ALTER TABLE "load_legs" ADD CONSTRAINT "load_legs_miles_source_check" CHECK ("miles_source" IS NULL OR "miles_source" IN ('eld', 'driver', 'dispatcher', 'remainder'));

ALTER TABLE "handoffs" DROP CONSTRAINT "handoffs_state_check";
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_state_check" CHECK ("state" IN ('dropped', 'received', 'disputed', 'cancelled'));

ALTER TABLE "drivers" ADD COLUMN "pay_arrangement" TEXT;
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_pay_arrangement_check" CHECK ("pay_arrangement" IS NULL OR "pay_arrangement" IN ('company', 'contractor'));

ALTER TABLE "workspaces" ADD COLUMN "default_pay_arrangement" TEXT NOT NULL DEFAULT 'company';
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_pay_arrangement_check" CHECK ("default_pay_arrangement" IN ('company', 'contractor'));

ALTER TABLE "workspaces" ADD COLUMN "pay_miles_basis" TEXT NOT NULL DEFAULT 'logged';
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_pay_miles_basis_check" CHECK ("pay_miles_basis" IN ('logged', 'billable'));
