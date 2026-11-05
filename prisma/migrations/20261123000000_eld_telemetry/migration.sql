-- ELD telemetry (docs/PARTNER_BACKBONE.md): where a tractor was last seen, and the hours left on a driver's clocks. All optional, all written only by the ELD sync.
ALTER TABLE "vehicles" ADD COLUMN "last_lat" DECIMAL(9,6),
ADD COLUMN "last_lng" DECIMAL(9,6),
ADD COLUMN "last_located_at" TIMESTAMP(3);

ALTER TABLE "drivers" ADD COLUMN "eld_driver_id" TEXT,
ADD COLUMN "hos_drive_minutes" INTEGER,
ADD COLUMN "hos_shift_minutes" INTEGER,
ADD COLUMN "hos_cycle_minutes" INTEGER,
ADD COLUMN "hos_synced_at" TIMESTAMP(3);
