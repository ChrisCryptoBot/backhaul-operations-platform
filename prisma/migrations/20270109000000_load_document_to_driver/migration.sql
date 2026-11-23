-- Sync plan Step 4: a file of kind "other" goes to the driver's phone only when the dispatcher says so. Bills of lading, delivery instructions and lumper receipts always do.
ALTER TABLE "load_documents" ADD COLUMN IF NOT EXISTS "to_driver" BOOLEAN NOT NULL DEFAULT false;

-- The kinds gain the bill of lading, delivery instructions and the lumper receipt (src/lib/documents.ts DOC_KINDS).
ALTER TABLE "load_documents" DROP CONSTRAINT IF EXISTS "load_documents_kind_check";
ALTER TABLE "load_documents" ADD CONSTRAINT "load_documents_kind_check" CHECK ("kind" IN ('rate_con', 'pod', 'bol', 'instructions', 'lumper', 'receipt', 'other'));
