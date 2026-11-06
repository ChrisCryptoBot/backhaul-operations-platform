-- Generated from prisma/migrations/20261202000000_regions_scope/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Regions and scope (docs/SCOPE.md): a region groups terminals, and a person can be limited to a region or to terminals. Seeds nothing: terminals start unassigned and nobody is limited.

CREATE TABLE "regions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "regions_workspace_id_archived_at_idx" ON "regions"("workspace_id", "archived_at");
-- One live region of a name per workspace, ignoring case.
CREATE UNIQUE INDEX "regions_workspace_name_live_key" ON "regions"("workspace_id", lower("name")) WHERE "archived_at" IS NULL;
ALTER TABLE "regions" ADD CONSTRAINT "regions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "terminals" ADD COLUMN "region_id" TEXT;
CREATE INDEX "terminals_region_id_idx" ON "terminals"("region_id");
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "member_scopes" (
  "id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "region_id" TEXT,
  "terminal" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_scopes_pkey" PRIMARY KEY ("id"),
  -- A row names a region or a terminal, never both and never neither.
  CONSTRAINT "member_scopes_one_of" CHECK (("region_id" IS NOT NULL AND "terminal" IS NULL) OR ("region_id" IS NULL AND "terminal" IS NOT NULL))
);
CREATE INDEX "member_scopes_member_id_idx" ON "member_scopes"("member_id");
ALTER TABLE "member_scopes" ADD CONSTRAINT "member_scopes_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_scopes" ADD CONSTRAINT "member_scopes_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
