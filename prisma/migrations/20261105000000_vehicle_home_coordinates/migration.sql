-- Where a truck is based, found once, so measuring a quote does not geocode the address again.
ALTER TABLE "vehicles"
  ADD COLUMN "home_base_lat" DECIMAL(9,6),
  ADD COLUMN "home_base_lng" DECIMAL(9,6);
