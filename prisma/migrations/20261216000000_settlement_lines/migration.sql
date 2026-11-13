-- Statement lines as rows (docs/MONEY_PLAN.md, Wave 4 step 1, gap 8, rule J). Additive. One row per line of a final or voided driver statement, frozen at finalize: a load's pay
-- (positive), a fuel card purchase taken off (negative) and each typed adjustment (signed as typed). A statement's rows add up to its total to the cent. The JSON columns stay as a
-- projection until every reader moves to the rows. Sort keeps the statement's own order: loads from 0, fuel from 10000, adjustments from 20000.

CREATE TABLE "settlement_lines" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "settlement_id" TEXT NOT NULL,
  "sort" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "basis" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "load_id" TEXT,
  "load_number" TEXT,
  "delivered_at" TIMESTAMP(3),
  "pay_kind" TEXT,
  "pay_rate" DECIMAL(12,4),
  "hours" DECIMAL(8,2),
  "fuel_transaction_id" TEXT,
  "gallons" DECIMAL(10,3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_lines_settlement_id_sort_key" ON "settlement_lines"("settlement_id", "sort");
CREATE INDEX "settlement_lines_workspace_id_kind_idx" ON "settlement_lines"("workspace_id", "kind");
CREATE INDEX "settlement_lines_load_id_idx" ON "settlement_lines"("load_id");
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill every final and voided statement from the JSON it was frozen with. Numbers that are not numbers are skipped (they cannot be money); a load line with no amount is 0, as the
-- statement's total counted it.
INSERT INTO "settlement_lines" ("id", "workspace_id", "settlement_id", "sort", "kind", "label", "basis", "amount", "load_id", "load_number", "delivered_at", "pay_kind", "pay_rate", "hours")
SELECT gen_random_uuid()::text, s."workspace_id", s."id", (e.n - 1)::int, 'load',
       COALESCE(NULLIF(e.v->>'loadNumber', ''), 'Load') || COALESCE(', ' || NULLIF(e.v->>'lane', ''), ''),
       e.v->>'basis',
       CASE WHEN jsonb_typeof(e.v->'amount') = 'number' THEN round((e.v->>'amount')::numeric, 2) ELSE 0 END,
       e.v->>'loadId', e.v->>'loadNumber',
       CASE WHEN e.v->>'deliveredAt' ~ '^\d{4}-\d{2}-\d{2}T' THEN (e.v->>'deliveredAt')::timestamptz AT TIME ZONE 'UTC' END,
       e.v->>'payKind',
       CASE WHEN jsonb_typeof(e.v->'payRate') = 'number' THEN (e.v->>'payRate')::numeric END,
       CASE WHEN jsonb_typeof(e.v->'hours') = 'number' THEN round((e.v->>'hours')::numeric, 2) END
FROM "settlements" s, jsonb_array_elements(CASE WHEN jsonb_typeof(s."lines") = 'array' THEN s."lines" ELSE '[]'::jsonb END) WITH ORDINALITY AS e(v, n)
WHERE s."status" IN ('final', 'void');

INSERT INTO "settlement_lines" ("id", "workspace_id", "settlement_id", "sort", "kind", "label", "basis", "amount", "load_number", "fuel_transaction_id", "gallons")
SELECT gen_random_uuid()::text, s."workspace_id", s."id", 10000 + (e.n - 1)::int, 'fuel',
       'Fuel card' || COALESCE(', ' || NULLIF(e.v->>'location', ''), ''),
       NULLIF(e.v->>'on', ''),
       -round((e.v->>'amount')::numeric, 2),
       e.v->>'loadNumber', e.v->>'id',
       CASE WHEN jsonb_typeof(e.v->'gallons') = 'number' THEN round((e.v->>'gallons')::numeric, 3) END
FROM "settlements" s, jsonb_array_elements(CASE WHEN jsonb_typeof(s."fuel") = 'array' THEN s."fuel" ELSE '[]'::jsonb END) WITH ORDINALITY AS e(v, n)
WHERE s."status" IN ('final', 'void') AND jsonb_typeof(e.v->'amount') = 'number';

INSERT INTO "settlement_lines" ("id", "workspace_id", "settlement_id", "sort", "kind", "label", "amount")
SELECT gen_random_uuid()::text, s."workspace_id", s."id", 20000 + (e.n - 1)::int, 'adjustment',
       COALESCE(NULLIF(e.v->>'label', ''), 'Adjustment'),
       round((e.v->>'amount')::numeric, 2)
FROM "settlements" s, jsonb_array_elements(CASE WHEN jsonb_typeof(s."adjustments") = 'array' THEN s."adjustments" ELSE '[]'::jsonb END) WITH ORDINALITY AS e(v, n)
WHERE s."status" IN ('final', 'void') AND jsonb_typeof(e.v->'amount') = 'number';
