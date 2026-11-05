-- Generated from prisma/migrations/20261127000000_driver_shifts/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Driver shifts and availability, driver codes, and a managed list of terminals (docs/DRIVER_SHIFTS.md).

-- Driver codes: first initial + first three letters of the last name, a number on the end for the second and later holders of a code.
ALTER TABLE "drivers" ADD COLUMN "code" TEXT;

-- Backfill in created order, per workspace, so the oldest John Smith keeps JSMI. The base mirrors src/lib/driver-code.ts for ordinary names (the first word's letter, the last word's first three letters,
-- accents and punctuation dropped); a name that gives no letters is DRV.
WITH cleaned AS (
  SELECT id, workspace_id, created_at,
    regexp_split_to_array(btrim(regexp_replace(btrim(name), '(\s+(jr|sr|ii|iii|iv|v)\.?)+$', '', 'i')), '\s+') AS w,
    'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿ' AS f,
    'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy' AS t
  FROM "drivers"
), base AS (
  SELECT id, workspace_id, created_at,
    COALESCE(NULLIF(
      CASE
        WHEN array_length(w, 1) > 1 THEN
          upper(left(regexp_replace(translate(w[1], f, t), '[^A-Za-z]', '', 'g'), 1))
          || upper(left(regexp_replace(translate(w[array_length(w, 1)], f, t), '[^A-Za-z]', '', 'g'), 3))
        ELSE upper(left(regexp_replace(translate(w[1], f, t), '[^A-Za-z]', '', 'g'), 4))
      END, ''), 'DRV') AS b
  FROM cleaned
), numbered AS (
  SELECT id, b, row_number() OVER (PARTITION BY workspace_id, b ORDER BY created_at, id) AS n FROM base
)
UPDATE "drivers" d SET "code" = CASE WHEN n.n = 1 THEN n.b ELSE n.b || n.n::text END FROM numbered n WHERE d.id = n.id;

CREATE UNIQUE INDEX "drivers_workspace_id_code_key" ON "drivers"("workspace_id", "code");

-- Terminals: a named list. Seeded from the values already in use on drivers, trucks and trailers.
CREATE TABLE "terminals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "city" TEXT,
  "note" TEXT,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "terminals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "terminals_workspace_id_archived_at_idx" ON "terminals"("workspace_id", "archived_at");
CREATE UNIQUE INDEX "terminals_workspace_id_lower_name_key" ON "terminals"("workspace_id", lower("name"));
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "terminals" ("id", "workspace_id", "name")
SELECT 'trm_' || md5(workspace_id || ':' || lower(terminal)), workspace_id, min(terminal)
FROM (
  SELECT workspace_id, terminal FROM "drivers" WHERE terminal IS NOT NULL AND btrim(terminal) <> ''
  UNION ALL SELECT workspace_id, terminal FROM "vehicles" WHERE terminal IS NOT NULL AND btrim(terminal) <> ''
  UNION ALL SELECT workspace_id, terminal FROM "trailers" WHERE terminal IS NOT NULL AND btrim(terminal) <> ''
) used
GROUP BY workspace_id, lower(terminal);

-- Shift templates and one-day exceptions.
CREATE TABLE "driver_schedules" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "week" JSONB NOT NULL,
  "set_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "driver_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "driver_schedules_driver_id_key" ON "driver_schedules"("driver_id");
CREATE INDEX "driver_schedules_workspace_id_idx" ON "driver_schedules"("workspace_id");
ALTER TABLE "driver_schedules" ADD CONSTRAINT "driver_schedules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_schedules" ADD CONSTRAINT "driver_schedules_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "driver_shift_exceptions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "driver_id" TEXT NOT NULL,
  "date_key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "start_minute" INTEGER,
  "end_minute" INTEGER,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "driver_shift_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "driver_shift_exceptions_driver_id_date_key_key" ON "driver_shift_exceptions"("driver_id", "date_key");
CREATE INDEX "driver_shift_exceptions_workspace_id_date_key_idx" ON "driver_shift_exceptions"("workspace_id", "date_key");
ALTER TABLE "driver_shift_exceptions" ADD CONSTRAINT "driver_shift_exceptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "driver_shift_exceptions" ADD CONSTRAINT "driver_shift_exceptions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
