-- What a dispatcher keeps on a load beyond its route and rate: weight and size, what it needs, the broker's contact, notes, what the proof of
-- delivery is, and the invoice as billed line by line. All additive and nullable.
ALTER TABLE "loads" ADD COLUMN "weight_lbs" INTEGER;
ALTER TABLE "loads" ADD COLUMN "length_ft" DECIMAL(8,2);
ALTER TABLE "loads" ADD COLUMN "width_ft" DECIMAL(8,2);
ALTER TABLE "loads" ADD COLUMN "load_height_in" DECIMAL(8,2);
ALTER TABLE "loads" ADD COLUMN "hazmat_class" TEXT;
ALTER TABLE "loads" ADD COLUMN "requires_liftgate" BOOLEAN;
ALTER TABLE "loads" ADD COLUMN "requires_ramp" BOOLEAN;
ALTER TABLE "loads" ADD COLUMN "requires_pallet_jack" BOOLEAN;
ALTER TABLE "loads" ADD COLUMN "broker_phone" TEXT;
ALTER TABLE "loads" ADD COLUMN "broker_email" TEXT;
ALTER TABLE "loads" ADD COLUMN "notes" TEXT;
ALTER TABLE "loads" ADD COLUMN "pod_note" TEXT;
ALTER TABLE "loads" ADD COLUMN "invoice_lines" JSONB;
