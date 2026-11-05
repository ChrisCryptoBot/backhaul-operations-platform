-- Generated from prisma/migrations/20261119000000_accounting_role/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Four roles (viewer, dispatcher, accounting, admin): "owner" becomes "admin", and a person can carry grants an admin gave them (today only "bill", for a dispatcher).
ALTER TABLE "members" DROP CONSTRAINT "members_role_check";
UPDATE "members" SET "role" = 'admin' WHERE "role" = 'owner';
ALTER TABLE "members" ADD CONSTRAINT "members_role_check" CHECK ("role" IN ('viewer', 'dispatcher', 'accounting', 'admin'));
ALTER TABLE "members" ADD COLUMN "grants" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "members" ADD CONSTRAINT "members_grants_check" CHECK ("grants" <@ ARRAY['bill']::TEXT[]);
