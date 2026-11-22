-- Phase 2 step 3 (Messages): a bridge outbox row can carry a desk message to the driver's phone instead of a load.
ALTER TABLE "bridge_outbox" ALTER COLUMN "load_id" DROP NOT NULL;
ALTER TABLE "bridge_outbox" ADD COLUMN IF NOT EXISTS "message_id" TEXT;
CREATE INDEX IF NOT EXISTS "bridge_outbox_message_id_idx" ON "bridge_outbox"("message_id");
