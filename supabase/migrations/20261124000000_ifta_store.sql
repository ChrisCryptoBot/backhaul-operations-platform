-- Generated from prisma/migrations/20261124000000_ifta_store/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- The IFTA mileage store (docs/PARTNER_BACKBONE.md): a quarter's miles and gallons by state, replaced as a whole each time the quarter is worked out.
CREATE TABLE "ifta_lines" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "quarter" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "miles" DECIMAL(12,1) NOT NULL,
  "gallons" DECIMAL(12,2) NOT NULL,
  "source" TEXT NOT NULL,
  "loads" INTEGER NOT NULL,
  "computed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ifta_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ifta_lines_workspace_id_quarter_state_key" ON "ifta_lines"("workspace_id", "quarter", "state");
ALTER TABLE "ifta_lines" ADD CONSTRAINT "ifta_lines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
