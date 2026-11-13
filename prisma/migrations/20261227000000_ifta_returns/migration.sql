-- Filed IFTA returns, frozen (docs/MONEY_PLAN.md, Wave 5 step 8). Additive.
--   ifta_returns: what was filed for a quarter, as it was worked out at the moment of filing (server/partners/ifta-filing.ts): the totals, the fleet MPG, the rate table's state, who filed it and
--   when, and whether provisional rates were confirmed. At most one FILED return per workspace and quarter (partial unique index). Reopening keeps the row (status "reopened", who, when,
--   why) and frees the quarter; filing again is an amendment, a new row. ifta_return_lines: one row per jurisdiction of the snapshot.
--   The figures can never be edited: a trigger refuses any UPDATE of a line, and any UPDATE of a return other than filed -> reopened with its three reopen fields.

CREATE TABLE "ifta_returns" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "quarter" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'filed',
  "filed_at" TIMESTAMP(3) NOT NULL,
  "filed_by" TEXT NOT NULL,
  "due_date" TEXT NOT NULL,
  "rate_state" TEXT NOT NULL,
  "provisional_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "miles" DECIMAL(14,1) NOT NULL,
  "gallons" DECIMAL(14,3) NOT NULL,
  "tax_paid_gallons" DECIMAL(14,3) NOT NULL,
  "bulk_gallons" DECIMAL(14,3) NOT NULL,
  "mpg" DECIMAL(8,2),
  "tax" DECIMAL(14,2) NOT NULL,
  "surcharge" DECIMAL(14,2) NOT NULL,
  "total" DECIMAL(14,2) NOT NULL,
  "trucks" INTEGER NOT NULL,
  "amends_id" TEXT,
  "reopened_at" TIMESTAMP(3),
  "reopened_by" TEXT,
  "reopen_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ifta_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ifta_returns_quarter_check" CHECK ("quarter" ~ '^\d{4}-Q[1-4]$'),
  CONSTRAINT "ifta_returns_status_check" CHECK ("status" IN ('filed', 'reopened')),
  CONSTRAINT "ifta_returns_rate_state_check" CHECK ("rate_state" IN ('provisional', 'mixed', 'final')),
  CONSTRAINT "ifta_returns_provisional_check" CHECK ("rate_state" = 'final' OR "provisional_confirmed"),
  CONSTRAINT "ifta_returns_reopen_check" CHECK (("status" = 'reopened') = ("reopened_at" IS NOT NULL AND "reopened_by" IS NOT NULL AND "reopen_reason" IS NOT NULL)),
  CONSTRAINT "ifta_returns_figures_check" CHECK ("miles" >= 0 AND "gallons" >= 0 AND "tax_paid_gallons" >= 0 AND "bulk_gallons" >= 0 AND "trucks" >= 0)
);

CREATE UNIQUE INDEX "ifta_returns_one_filed_key" ON "ifta_returns"("workspace_id", "quarter") WHERE "status" = 'filed';
CREATE INDEX "ifta_returns_workspace_id_quarter_idx" ON "ifta_returns"("workspace_id", "quarter");

ALTER TABLE "ifta_returns" ADD CONSTRAINT "ifta_returns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ifta_returns" ADD CONSTRAINT "ifta_returns_amends_id_fkey" FOREIGN KEY ("amends_id") REFERENCES "ifta_returns"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "ifta_return_lines" (
  "id" TEXT NOT NULL,
  "return_id" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "miles" DECIMAL(14,1) NOT NULL,
  "taxable_gallons" DECIMAL(14,0) NOT NULL,
  "tax_paid_gallons" DECIMAL(14,0) NOT NULL,
  "net_gallons" DECIMAL(14,0) NOT NULL,
  "rate" DECIMAL(8,4) NOT NULL,
  "surcharge_rate" DECIMAL(8,4) NOT NULL,
  "tax" DECIMAL(14,2) NOT NULL,
  "surcharge" DECIMAL(14,2) NOT NULL,
  "total" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "ifta_return_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ifta_return_lines_jurisdiction_check" CHECK ("jurisdiction" IN ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'))
);

CREATE UNIQUE INDEX "ifta_return_lines_return_id_jurisdiction_key" ON "ifta_return_lines"("return_id", "jurisdiction");

ALTER TABLE "ifta_return_lines" ADD CONSTRAINT "ifta_return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "ifta_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A filed return's figures are what was filed: nothing edits them. The only change a return may take is filed -> reopened, setting who, when and why and nothing else.
CREATE OR REPLACE FUNCTION ifta_returns_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ifta_return_lines' THEN
    RAISE EXCEPTION 'A filed IFTA return line cannot be changed';
  END IF;
  IF OLD.status = 'filed' AND NEW.status = 'reopened'
     AND (NEW.id, NEW.workspace_id, NEW.quarter, NEW.filed_at, NEW.filed_by, NEW.due_date, NEW.rate_state, NEW.provisional_confirmed, NEW.miles, NEW.gallons, NEW.tax_paid_gallons, NEW.bulk_gallons, NEW.mpg, NEW.tax, NEW.surcharge, NEW.total, NEW.trucks, NEW.amends_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.workspace_id, OLD.quarter, OLD.filed_at, OLD.filed_by, OLD.due_date, OLD.rate_state, OLD.provisional_confirmed, OLD.miles, OLD.gallons, OLD.tax_paid_gallons, OLD.bulk_gallons, OLD.mpg, OLD.tax, OLD.surcharge, OLD.total, OLD.trucks, OLD.amends_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A filed IFTA return cannot be changed; reopen it instead';
END;
$$;

CREATE TRIGGER "ifta_returns_frozen" BEFORE UPDATE ON "ifta_returns" FOR EACH ROW EXECUTE FUNCTION ifta_returns_frozen();
CREATE TRIGGER "ifta_return_lines_frozen" BEFORE UPDATE ON "ifta_return_lines" FOR EACH ROW EXECUTE FUNCTION ifta_returns_frozen();
