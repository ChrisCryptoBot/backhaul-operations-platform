-- Generated from prisma/migrations/20261109000000_plan_default_and_check/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- A workspace is always on a plan. One made without a plan is held to Starter (the desk reads a missing plan as Starter), and a plan can only be one of the four words.
-- Workspaces that exist today and have none chosen are put on the plan their fleet's size falls in (1 to 3 trucks Starter, 4 to 10 Growth, 11 to 49 Pro, 50 and up Enterprise),
-- so a demo database keeps working at the size it has; a person changes the plan after that.

UPDATE "workspaces" w
SET "plan" = CASE
  WHEN t.n >= 50 THEN 'enterprise'
  WHEN t.n >= 11 THEN 'pro'
  WHEN t.n >= 4 THEN 'growth'
  ELSE 'starter'
END
FROM (
  SELECT ws."id" AS id, (SELECT COUNT(*) FROM "vehicles" v WHERE v."workspace_id" = ws."id" AND v."archived_at" IS NULL) AS n
  FROM "workspaces" ws
) t
WHERE w."id" = t.id AND w."plan" IS NULL;

ALTER TABLE "workspaces" ALTER COLUMN "plan" SET DEFAULT 'starter';
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_check" CHECK ("plan" IS NULL OR "plan" IN ('starter', 'growth', 'pro', 'enterprise'));
