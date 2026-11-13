-- Generated from prisma/migrations/20261220000000_payroll_status_poll/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Payroll status poll (docs/MONEY_PLAN.md, Wave 4 step 5, gap 12). Additive.
--   payroll_checked_at: when the desk last asked payroll about the statement's run, so the poll asks each run at most every few hours and a "still pending" answer writes nothing else.
--   payroll_rejected_at, payroll_reject_reason: payroll refused the payment (by webhook or found by the poll). The statement is released (no reference, not sent) so it can be fixed and sent
--   again; these say why until it is.

ALTER TABLE "settlements" ADD COLUMN "payroll_checked_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN "payroll_rejected_at" TIMESTAMP(3);
ALTER TABLE "settlements" ADD COLUMN "payroll_reject_reason" TEXT;
CREATE INDEX "settlements_status_payroll_sent_at_idx" ON "settlements"("status", "payroll_sent_at");
