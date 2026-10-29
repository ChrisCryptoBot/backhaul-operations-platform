-- Daily target, route minimum and the confirmed hourly target on a truck's cost profile; a driver's usual pay; three more fields frozen on a load
-- when it is booked. All additive and nullable, so nothing existing changes.
ALTER TABLE "cost_profiles" ADD COLUMN "daily_revenue_target" DECIMAL(12,2);
ALTER TABLE "cost_profiles" ADD COLUMN "route_base_minimum" DECIMAL(12,2);
ALTER TABLE "cost_profiles" ADD COLUMN "route_included_miles" DECIMAL(12,2);
ALTER TABLE "cost_profiles" ADD COLUMN "route_included_stops" INTEGER;
ALTER TABLE "cost_profiles" ADD COLUMN "route_overage_per_mile" DECIMAL(8,4);
ALTER TABLE "cost_profiles" ADD COLUMN "route_overage_per_stop" DECIMAL(8,2);
ALTER TABLE "cost_profiles" ADD COLUMN "hourly_target_confirmed_at" TIMESTAMP(3);

ALTER TABLE "drivers" ADD COLUMN "default_pay_kind" TEXT;
ALTER TABLE "drivers" ADD COLUMN "default_pay_rate" DECIMAL(12,4);

ALTER TABLE "loads" ADD COLUMN "snapshot_fsc_cut_applies" BOOLEAN;
ALTER TABLE "loads" ADD COLUMN "snapshot_detention_rate" DECIMAL(8,2);
ALTER TABLE "loads" ADD COLUMN "snapshot_free_grace_minutes" INTEGER;
