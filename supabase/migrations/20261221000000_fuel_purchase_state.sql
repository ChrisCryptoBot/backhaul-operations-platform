-- Generated from prisma/migrations/20261221000000_fuel_purchase_state/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Fuel purchases get a state, a product and a status (docs/MONEY_PLAN.md, Wave 5 step 1). Additive, with a backfill.
--   purchase_state, purchase_city: where it was bought, read cleanly. Fuel tax (IFTA) credits a purchase's tax-paid gallons to this jurisdiction, so it is a column, not part of `location`.
--   product: road_diesel | reefer_diesel | def | gasoline | other | unknown. Reefer diesel and DEF are kept apart from the tractor's road diesel.
--   tax_paid: tax was paid at the pump (retail). Bulk fuel is not.
--   purchased_at: the moment of purchase when the source gives one; posted_at stays the calendar day at noon UTC.
--   status: settled | pending | declined | void. Only settled purchases are offered on a statement or counted in totals.
--   vehicles.tank_capacity_gallons: the tractor's tanks, for the over-capacity flag (Wave 5 step 3).
--
-- Backfill: the state and city come from the end of `location` ("Merchant, City, ST" or "City, ST 75201"), and only a real US state, DC or a Canadian province is kept. The product follows
-- what the only shipped card adapter (WEX) did before: it stored DEF with no gallons and diesel with gallons, so a WEX row with no gallons is DEF and any row with gallons is road diesel.
-- Everything else stays unknown. Existing rows are settled (only settled purchases were ever stored).

ALTER TABLE "fuel_transactions" ADD COLUMN "purchase_state" TEXT;
ALTER TABLE "fuel_transactions" ADD COLUMN "purchase_city" TEXT;
ALTER TABLE "fuel_transactions" ADD COLUMN "product" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "fuel_transactions" ADD COLUMN "tax_paid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "fuel_transactions" ADD COLUMN "purchased_at" TIMESTAMP(3);
ALTER TABLE "fuel_transactions" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'settled';
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_product_check" CHECK ("product" IN ('road_diesel', 'reefer_diesel', 'def', 'gasoline', 'other', 'unknown'));
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_status_check" CHECK ("status" IN ('settled', 'pending', 'declined', 'void'));
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_purchase_state_check" CHECK ("purchase_state" IS NULL OR "purchase_state" ~ '^[A-Z]{2}$');
CREATE INDEX "fuel_transactions_workspace_id_purchase_state_idx" ON "fuel_transactions"("workspace_id", "purchase_state");

ALTER TABLE "vehicles" ADD COLUMN "tank_capacity_gallons" DECIMAL(8,1);
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tank_capacity_gallons_check" CHECK ("tank_capacity_gallons" IS NULL OR "tank_capacity_gallons" > 0);

WITH parts AS (
  SELECT "id", regexp_split_to_array(trim("location"), '\s*,\s*') AS p
  FROM "fuel_transactions"
  WHERE "location" IS NOT NULL AND "purchase_state" IS NULL
), read AS (
  SELECT "id",
         upper(substring(p[array_length(p, 1)] FROM '^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$')) AS st,
         CASE WHEN array_length(p, 1) >= 2 THEN nullif(p[array_length(p, 1) - 1], '') END AS city
  FROM parts
)
UPDATE "fuel_transactions" f
SET "purchase_state" = r.st, "purchase_city" = r.city
FROM read r
WHERE f."id" = r."id"
  AND r.st IN ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
               'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');

UPDATE "fuel_transactions" SET "product" = 'def' WHERE "product" = 'unknown' AND "provider" = 'wex' AND "gallons" IS NULL;
UPDATE "fuel_transactions" SET "product" = 'road_diesel' WHERE "product" = 'unknown' AND "gallons" IS NOT NULL;
