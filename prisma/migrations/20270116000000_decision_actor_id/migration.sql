-- Quote review Q3 (2026-11-25): who made a quote decision, by a stable id beside the name. The name alone changed with a rename and two people
-- could share one, so a dispatcher's "my decisions" report could lose their history or show someone else's. Nullable: decisions made before
-- this keep the name only, and the report falls back to the name for them. No row changes.
ALTER TABLE "load_decisions" ADD COLUMN IF NOT EXISTS "decided_by_id" TEXT;
CREATE INDEX IF NOT EXISTS "load_decisions_decided_by_id_idx" ON "load_decisions" ("decided_by_id");
