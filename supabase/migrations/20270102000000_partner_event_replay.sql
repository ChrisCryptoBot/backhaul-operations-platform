-- Generated from prisma/migrations/20270102000000_partner_event_replay/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Money plan Wave 7 step 4: dead letters and the Partner issues screen. An inbound event keeps its verified body while it may be needed again (being applied, failed, or ignored for a
-- reason a person can fix), so it can be replayed from the desk under the same once-only key; a person can settle an inbound event or a failed outbound delivery, with what they said.
ALTER TABLE "partner_events" ADD COLUMN "payload" TEXT;
ALTER TABLE "partner_events" ADD COLUMN "attempted_at" TIMESTAMP(3);
ALTER TABLE "partner_events" ADD COLUMN "resolved_at" TIMESTAMP(3);
ALTER TABLE "partner_events" ADD COLUMN "resolved_by" TEXT;
ALTER TABLE "partner_events" ADD COLUMN "resolution" TEXT;
ALTER TABLE "partner_events" ADD COLUMN "resolution_note" TEXT;
CREATE INDEX "partner_events_workspace_id_outcome_idx" ON "partner_events"("workspace_id", "outcome");

ALTER TABLE "webhook_deliveries" ADD COLUMN "resolved_at" TIMESTAMP(3);
ALTER TABLE "webhook_deliveries" ADD COLUMN "resolved_by" TEXT;
ALTER TABLE "webhook_deliveries" ADD COLUMN "resolution" TEXT;
ALTER TABLE "webhook_deliveries" ADD COLUMN "resolution_note" TEXT;
