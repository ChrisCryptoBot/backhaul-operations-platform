-- Generated from prisma/migrations/20261230000000_money_moving_switch/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Money plan Wave 7 step 1 (Gap 14): the per-workspace money-moving switch. Off for every fleet; an admin turns it on with a reason, and it only counts where the server's operator has set
-- MONEY_MOVING_COUNSEL_APPROVED=yes. Who flipped it last, when, and why are kept beside it (the audit trail has the full history).
ALTER TABLE "workspaces" ADD COLUMN "money_moving_live" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspaces" ADD COLUMN "money_moving_by" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "money_moving_at" TIMESTAMP(3);
ALTER TABLE "workspaces" ADD COLUMN "money_moving_reason" TEXT;
