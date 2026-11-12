-- Generated from prisma/migrations/20261210000000_invoice_records/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Invoices as their own records (docs/MONEY_PLAN.md, Wave 1). Additive: four new tables, filled once from the invoice fields every load already has.
-- The load keeps those fields as a projection, written by the same transaction as the record, so every older reader is unchanged.
-- Ids of backfilled rows are derived from the row they came from (inv_<load>, il_<load>_<n>, ip_<payment>), so running the fill twice inserts nothing new.

CREATE TABLE "invoices" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'invoice',
  "status" TEXT NOT NULL DEFAULT 'open',
  "bill_to_name" TEXT,
  "bill_to_mc" TEXT,
  "bill_to_email" TEXT,
  "bill_to_phone" TEXT,
  "issued_at" TIMESTAMP(3) NOT NULL,
  "terms_days" INTEGER NOT NULL DEFAULT 0,
  "total" DECIMAL(12,2) NOT NULL,
  "paid_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paid_at" TIMESTAMP(3),
  "write_off_amount" DECIMAL(12,2),
  "write_off_reason" TEXT,
  "write_off_code" TEXT,
  "credit_of_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  "factoring_status" TEXT NOT NULL DEFAULT 'none',
  "factoring_reference_id" TEXT,
  "factoring_updated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoices_kind_check" CHECK ("kind" IN ('invoice', 'credit_memo')),
  CONSTRAINT "invoices_status_check" CHECK ("status" IN ('open', 'paid', 'void'))
);
CREATE UNIQUE INDEX "invoices_workspace_id_number_key" ON "invoices"("workspace_id", "number");
CREATE INDEX "invoices_workspace_id_status_issued_at_idx" ON "invoices"("workspace_id", "status", "issued_at");
CREATE INDEX "invoices_workspace_id_kind_idx" ON "invoices"("workspace_id", "kind");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_of_id_fkey" FOREIGN KEY ("credit_of_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "invoice_lines" (
  "id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "load_id" TEXT,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "sort" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_lines_kind_check" CHECK ("kind" IN ('linehaul', 'fuel_surcharge', 'detention', 'lumper', 'layover', 'tonu', 'stop_off', 'credit', 'other'))
);
CREATE INDEX "invoice_lines_invoice_id_sort_idx" ON "invoice_lines"("invoice_id", "sort");
CREATE INDEX "invoice_lines_load_id_idx" ON "invoice_lines"("load_id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "invoice_loads" (
  "invoice_id" TEXT NOT NULL,
  "load_id" TEXT NOT NULL,
  CONSTRAINT "invoice_loads_pkey" PRIMARY KEY ("invoice_id", "load_id")
);
CREATE INDEX "invoice_loads_load_id_idx" ON "invoice_loads"("load_id");
ALTER TABLE "invoice_loads" ADD CONSTRAINT "invoice_loads_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_loads" ADD CONSTRAINT "invoice_loads_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "invoice_payments" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "paid_at" TIMESTAMP(3) NOT NULL,
  "method" TEXT,
  "reference" TEXT,
  "payer" TEXT,
  "note" TEXT,
  "source" TEXT NOT NULL DEFAULT 'desk',
  "external_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_payments_workspace_id_source_external_id_key" ON "invoice_payments"("workspace_id", "source", "external_id");
CREATE INDEX "invoice_payments_invoice_id_paid_at_idx" ON "invoice_payments"("invoice_id", "paid_at");
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one invoice per load that has one, with the amount every reader already uses (billedOf in src/lib/billed.ts).
INSERT INTO "invoices" ("id", "workspace_id", "number", "kind", "status", "bill_to_name", "bill_to_mc", "bill_to_email", "bill_to_phone", "issued_at", "terms_days", "total", "paid_total", "paid_at", "write_off_amount", "write_off_reason", "factoring_status", "factoring_reference_id", "factoring_updated_at", "created_at", "updated_at")
SELECT 'inv_' || l."id", l."workspace_id", l."invoice_number", 'invoice',
  CASE WHEN l."payment_status" = 'paid' THEN 'paid' ELSE 'open' END,
  l."broker_name", l."broker_mc_number", l."broker_email", l."broker_phone",
  l."invoiced_at", COALESCE(l."pay_terms_days", 0),
  ROUND(COALESCE(l."invoiced_amount", CASE WHEN l."status" = 'tonu' THEN COALESCE(l."tonu_revenue", 0) ELSE l."quoted_revenue" + COALESCE(l."fuel_surcharge", 0) END), 2),
  ROUND(COALESCE(l."paid_amount", 0), 2), l."paid_at", l."write_off_amount", l."write_off_reason",
  l."factoring_status", l."factoring_reference_id", l."factoring_updated_at", l."invoiced_at", CURRENT_TIMESTAMP
FROM "loads" l
WHERE l."invoice_number" IS NOT NULL AND l."invoiced_at" IS NOT NULL AND l."payment_status" IN ('invoiced', 'paid')
ON CONFLICT DO NOTHING;

INSERT INTO "invoice_loads" ("invoice_id", "load_id")
SELECT i."id", substr(i."id", 5) FROM "invoices" i WHERE i."id" LIKE 'inv\_%'
ON CONFLICT DO NOTHING;

-- Lines as billed; an invoice from before lines were kept gets one line for its total. The kind is read from the label the invoice dialog always wrote.
INSERT INTO "invoice_lines" ("id", "invoice_id", "load_id", "kind", "label", "amount", "sort")
SELECT 'il_' || l."id" || '_' || e.ord, 'inv_' || l."id", l."id",
  CASE lower(trim(e.line->>'label'))
    WHEN 'line haul' THEN 'linehaul' WHEN 'fuel surcharge' THEN 'fuel_surcharge' WHEN 'detention' THEN 'detention'
    WHEN 'lumper' THEN 'lumper' WHEN 'layover' THEN 'layover' WHEN 'tonu fee' THEN 'tonu' ELSE 'other' END,
  COALESCE(e.line->>'label', 'Line'), ROUND((e.line->>'amount')::numeric, 2), e.ord::int
FROM "loads" l
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l."invoice_lines") = 'array' THEN l."invoice_lines" ELSE '[]'::jsonb END) WITH ORDINALITY AS e(line, ord)
WHERE EXISTS (SELECT 1 FROM "invoices" i WHERE i."id" = 'inv_' || l."id")
ON CONFLICT DO NOTHING;

INSERT INTO "invoice_lines" ("id", "invoice_id", "load_id", "kind", "label", "amount", "sort")
SELECT 'il_' || substr(i."id", 5) || '_1', i."id", substr(i."id", 5), CASE WHEN l."status" = 'tonu' THEN 'tonu' ELSE 'linehaul' END,
  CASE WHEN l."status" = 'tonu' THEN 'TONU fee' ELSE 'Line haul and fuel surcharge' END, i."total", 1
FROM "invoices" i JOIN "loads" l ON l."id" = substr(i."id", 5)
WHERE i."id" LIKE 'inv\_%' AND NOT EXISTS (SELECT 1 FROM "invoice_lines" x WHERE x."invoice_id" = i."id")
ON CONFLICT DO NOTHING;

-- Payments, one row per payment already kept; a load marked paid before payments were kept one by one gets one legacy row for what it shows as received.
INSERT INTO "invoice_payments" ("id", "workspace_id", "invoice_id", "amount", "paid_at", "method", "source", "created_at")
SELECT 'ip_' || p."id", p."workspace_id", 'inv_' || p."load_id", ROUND(p."amount", 2), p."paid_at", p."method", 'desk', p."created_at"
FROM "load_payments" p WHERE EXISTS (SELECT 1 FROM "invoices" i WHERE i."id" = 'inv_' || p."load_id")
ON CONFLICT DO NOTHING;

INSERT INTO "invoice_payments" ("id", "workspace_id", "invoice_id", "amount", "paid_at", "method", "source", "created_at")
SELECT 'ipl_' || substr(i."id", 5), i."workspace_id", i."id", i."paid_total" - COALESCE(s.sum, 0), COALESCE(i."paid_at", i."issued_at"), l."paid_method", 'legacy', CURRENT_TIMESTAMP
FROM "invoices" i JOIN "loads" l ON l."id" = substr(i."id", 5)
LEFT JOIN (SELECT "invoice_id", SUM("amount") AS sum FROM "invoice_payments" GROUP BY "invoice_id") s ON s."invoice_id" = i."id"
WHERE i."id" LIKE 'inv\_%' AND i."paid_total" - COALESCE(s.sum, 0) > 0
ON CONFLICT DO NOTHING;
