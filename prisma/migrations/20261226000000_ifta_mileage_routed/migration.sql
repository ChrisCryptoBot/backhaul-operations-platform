-- Routed all-miles fallback (docs/MONEY_PLAN.md, Wave 5 step 5b). Additive.
--   ifta_mileage.method: "eld" (what an ELD reported, step 5a) or "routed" (legs the mileage company routed from the truck's loads, server/partners/ifta.ts). Every row before this is an
--   ELD row, so the default backfills them. A truck with ELD rows for a quarter uses only those; routed rows count only for a truck with none (lib/ifta-mileage.ts), so reading the ELD after
--   routing can never count a truck twice.
--   A routed leg has no odometer: start_odometer and end_odometer become nullable, and an ELD row must still carry both.

ALTER TABLE "ifta_mileage" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'eld';
ALTER TABLE "ifta_mileage" ADD CONSTRAINT "ifta_mileage_method_check" CHECK ("method" IN ('eld', 'routed'));
ALTER TABLE "ifta_mileage" ALTER COLUMN "start_odometer" DROP NOT NULL;
ALTER TABLE "ifta_mileage" ALTER COLUMN "end_odometer" DROP NOT NULL;
ALTER TABLE "ifta_mileage" ADD CONSTRAINT "ifta_mileage_eld_odometer_check" CHECK ("method" <> 'eld' OR ("start_odometer" IS NOT NULL AND "end_odometer" IS NOT NULL));
