-- Generated from prisma/migrations/20270105000000_bridge_outbox_messages/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Phase 2 step 3 (Messages): a bridge outbox row can carry a desk message to the driver's phone instead of a load.
ALTER TABLE "bridge_outbox" ALTER COLUMN "load_id" DROP NOT NULL;
ALTER TABLE "bridge_outbox" ADD COLUMN IF NOT EXISTS "message_id" TEXT;
CREATE INDEX IF NOT EXISTS "bridge_outbox_message_id_idx" ON "bridge_outbox"("message_id");
