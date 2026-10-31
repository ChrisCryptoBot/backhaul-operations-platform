-- What a quote decision was made on, and by whom, for the Quote decisions report. Nullable; earlier decisions keep reading as they did.
ALTER TABLE "load_decisions" ADD COLUMN "details" JSONB;
ALTER TABLE "load_decisions" ADD COLUMN "decided_by" TEXT;
