-- Phase 1: Driver & DirectCustomer reference entities (additive).
-- Existing free-text driver fields on "Load"/"LoadLeg" are untouched; optional
-- driverId FKs are added alongside them. No data backfill.

-- CreateEnum
CREATE TYPE "DriverAttribute" AS ENUM ('LTL_CERT', 'SLEEPER', 'TURNS_ONLY', 'DEDICATED', 'REGIONAL', 'FLEX', 'SHUTTLE', 'PTP');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- CreateEnum
CREATE TYPE "CadencePeriod" AS ENUM ('DAY', 'WEEK');

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "homeDropLotId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "attributes" "DriverAttribute"[] DEFAULT ARRAY[]::"DriverAttribute"[],
    "scheduleDays" "DayOfWeek"[] DEFAULT ARRAY[]::"DayOfWeek"[],
    "scheduleStart" VARCHAR(5),
    "scheduleTimeZone" TEXT,
    "scheduleNote" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectCustomer" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cadenceCount" INTEGER,
    "cadencePeriod" "CadencePeriod",
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectCustomer_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Load" ADD COLUMN "pickupDriverId" TEXT,
ADD COLUMN "deliveryDriverId" TEXT;

-- AlterTable
ALTER TABLE "LoadLeg" ADD COLUMN "driverId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Driver_regionId_code_key" ON "Driver"("regionId", "code");

-- CreateIndex
CREATE INDEX "Driver_regionId_active_idx" ON "Driver"("regionId", "active");

-- CreateIndex
CREATE INDEX "DirectCustomer_regionId_idx" ON "DirectCustomer"("regionId");

-- CreateIndex
CREATE INDEX "Load_pickupDriverId_idx" ON "Load"("pickupDriverId");

-- CreateIndex
CREATE INDEX "Load_deliveryDriverId_idx" ON "Load"("deliveryDriverId");

-- CreateIndex
CREATE INDEX "LoadLeg_driverId_idx" ON "LoadLeg"("driverId");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_homeDropLotId_fkey" FOREIGN KEY ("homeDropLotId") REFERENCES "DropLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectCustomer" ADD CONSTRAINT "DirectCustomer_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_pickupDriverId_fkey" FOREIGN KEY ("pickupDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_deliveryDriverId_fkey" FOREIGN KEY ("deliveryDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadLeg" ADD CONSTRAINT "LoadLeg_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
