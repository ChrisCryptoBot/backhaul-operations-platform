-- CreateEnum
CREATE TYPE "ApptType" AS ENUM ('FIRM_APPT', 'OPEN_WINDOW', 'FCFS');

-- AlterTable
ALTER TABLE "Load" ADD COLUMN     "deliveryApptType" "ApptType",
ADD COLUMN     "deliveryTimeZone" TEXT,
ADD COLUMN     "deliveryWindowEnd" TIMESTAMP(3),
ADD COLUMN     "deliveryWindowStart" TIMESTAMP(3),
ADD COLUMN     "pickupApptType" "ApptType",
ADD COLUMN     "pickupTimeZone" TEXT,
ADD COLUMN     "pickupWindowEnd" TIMESTAMP(3),
ADD COLUMN     "pickupWindowStart" TIMESTAMP(3);
