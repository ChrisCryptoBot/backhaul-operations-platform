-- Quarterly IFTA tax rates (docs/MONEY_PLAN.md, Wave 5 step 4). Additive.
--   ifta_rates: one row per workspace, quarter and US jurisdiction (DC included). `rate` (base diesel, $/gal) and `surcharge` ($/gal, 0 where none) are kept apart: the return credits fuel
--   bought against `rate` only. `status` provisional | final; `is_sample` marks made-up demo rates ("sample, not for filing"); `source_file` names the file. A rate file replaces its whole quarter
--   (server/partners/ifta-rates.ts). Canadian provinces are not stored (gap 15).

CREATE TABLE "ifta_rates" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "quarter" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "rate" DECIMAL(8,4) NOT NULL,
  "surcharge" DECIMAL(8,4) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "is_sample" BOOLEAN NOT NULL DEFAULT false,
  "source_file" TEXT,
  "import_batch_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ifta_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ifta_rates_quarter_check" CHECK ("quarter" ~ '^\d{4}-Q[1-4]$'),
  CONSTRAINT "ifta_rates_jurisdiction_check" CHECK ("jurisdiction" IN ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY')),
  CONSTRAINT "ifta_rates_rate_check" CHECK ("rate" >= 0),
  CONSTRAINT "ifta_rates_surcharge_check" CHECK ("surcharge" >= 0),
  CONSTRAINT "ifta_rates_status_check" CHECK ("status" IN ('provisional', 'final'))
);

CREATE UNIQUE INDEX "ifta_rates_workspace_id_quarter_jurisdiction_key" ON "ifta_rates"("workspace_id", "quarter", "jurisdiction");

ALTER TABLE "ifta_rates" ADD CONSTRAINT "ifta_rates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
