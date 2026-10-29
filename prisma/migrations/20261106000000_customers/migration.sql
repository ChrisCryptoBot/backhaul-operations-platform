-- Who a load is for, as a record: kind, MC, billing contact, default terms, notes. A load still keeps its customer as text.
CREATE TABLE "customers" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'broker',
  "mc_number" TEXT,
  "contact_name" TEXT,
  "contact_email" TEXT,
  "contact_phone" TEXT,
  "default_pay_terms_days" INTEGER,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customers_workspace_id_idx" ON "customers"("workspace_id");

-- One record per name in a workspace, whatever the capitalisation.
CREATE UNIQUE INDEX "customers_workspace_name_key" ON "customers" ("workspace_id", lower("name"));

ALTER TABLE "customers" ADD CONSTRAINT "customers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
