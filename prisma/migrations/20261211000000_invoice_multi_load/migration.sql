-- Invoices of several loads (docs/MONEY_PLAN.md, Wave 1, rule G). Every load on one invoice carries the invoice's number in its projected invoice_number, so the
-- old "one number, one load" index on loads cannot stay. The number is unique where it belongs now: invoices (workspace_id, number), created in 20261210000000.
DROP INDEX IF EXISTS "loads_workspace_invoice_number_key";
CREATE INDEX IF NOT EXISTS "loads_workspace_invoice_number_idx" ON "loads" ("workspace_id", "invoice_number") WHERE "invoice_number" IS NOT NULL;
