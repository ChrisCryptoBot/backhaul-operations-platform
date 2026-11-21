-- Phase 2 step 2 (G10): bridge_outbox rows are claimed with FOR UPDATE SKIP LOCKED and a short lease, as webhook_deliveries are, so overlapping runs never deliver one row twice.
ALTER TABLE "bridge_outbox" ADD COLUMN "lease_until" TIMESTAMP(3);
