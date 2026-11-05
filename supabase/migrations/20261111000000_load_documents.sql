-- Generated from prisma/migrations/20261111000000_load_documents/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Documents kept on a load (the rate confirmation, the proof of delivery, receipts). The bytes are in the desk's private storage; this table names them. Factoring reads it to know
-- what it can send, instead of taking a typed file name or a typed note as proof.

CREATE TABLE "load_documents" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "added_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "load_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "load_documents_kind_check" CHECK ("kind" IN ('rate_con', 'pod', 'receipt', 'other')),
  CONSTRAINT "load_documents_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "load_documents_load_id_idx" ON "load_documents"("load_id");
CREATE INDEX "load_documents_workspace_id_idx" ON "load_documents"("workspace_id");
