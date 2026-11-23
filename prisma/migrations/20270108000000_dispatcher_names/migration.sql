-- Who sent it (Chris 2026-11-22: a company with several dispatchers is one connection; the driver sees which dispatcher sent an offer or a message).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sent_by" TEXT;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "dispatched_by" TEXT;
