-- Generated from prisma/migrations/20270111000000_load_detention_waive/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

ALTER TABLE "loads"
  ADD COLUMN "detention_waived_at" TIMESTAMP(3),
  ADD COLUMN "detention_waived_by" TEXT,
  ADD COLUMN "detention_waived_reason" TEXT;

UPDATE "loads" AS l
SET
  "detention_waived_at" = e."created_at",
  "detention_waived_by" = e."actor",
  "detention_waived_reason" = COALESCE(NULLIF(BTRIM(e."reason"), ''), 'Waived')
FROM (
  SELECT DISTINCT ON ("workspace_id", "load_id")
    "workspace_id",
    "load_id",
    "created_at",
    "actor",
    "reason"
  FROM "audit_events"
  WHERE "action" = 'detention_waived' AND "load_id" IS NOT NULL
  ORDER BY "workspace_id", "load_id", "created_at" DESC, "id" DESC
) AS e
WHERE l."id" = e."load_id" AND l."workspace_id" = e."workspace_id";
