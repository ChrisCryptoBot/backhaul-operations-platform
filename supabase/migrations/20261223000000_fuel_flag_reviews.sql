-- Generated from prisma/migrations/20261223000000_fuel_flag_reviews/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Fuel exception flags (docs/MONEY_PLAN.md, Wave 5 step 3). Additive.
--   fuel_flag_reviews: a person cleared one flag on one fuel purchase, with why. One row per (purchase, flag code), so clearing one reason never hides another on the same purchase.
--   The flags themselves are worked out each time from the purchases (lib/fuel-exceptions.ts); only the person's decision is kept. Deleting the row reopens the flag.

CREATE TABLE "fuel_flag_reviews" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "fuel_transaction_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "reviewed_by" TEXT NOT NULL,
  "reviewed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fuel_flag_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_flag_reviews_code_check" CHECK ("code" IN ('over_capacity', 'duplicate', 'price_high', 'price_low', 'charge_mismatch', 'discount_over_price', 'zero_amount', 'non_diesel', 'no_state', 'no_truck')),
  CONSTRAINT "fuel_flag_reviews_note_check" CHECK (length(trim("note")) > 0)
);

CREATE UNIQUE INDEX "fuel_flag_reviews_fuel_transaction_id_code_key" ON "fuel_flag_reviews"("fuel_transaction_id", "code");
CREATE INDEX "fuel_flag_reviews_workspace_id_idx" ON "fuel_flag_reviews"("workspace_id");

ALTER TABLE "fuel_flag_reviews" ADD CONSTRAINT "fuel_flag_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fuel_flag_reviews" ADD CONSTRAINT "fuel_flag_reviews_fuel_transaction_id_fkey" FOREIGN KEY ("fuel_transaction_id") REFERENCES "fuel_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
