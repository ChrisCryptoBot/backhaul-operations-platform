-- Phase 2: Daily Booking Plan entries (additive).
-- New enum + table only; existing tables gain nothing but back-relations
-- (which are schema-level, not SQL-level).

-- CreateEnum
CREATE TYPE "BookingPlanStatus" AS ENUM ('NEEDS_BACKHAUL', 'SOURCING', 'BOOKED');

-- CreateTable
CREATE TABLE "BookingPlanEntry" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "driverId" TEXT NOT NULL,
    "expectedEmptyAt" VARCHAR(5),
    "emptyCity" TEXT,
    "emptyState" TEXT,
    "emptyCityAlt" TEXT,
    "backhaulNote" TEXT,
    "status" "BookingPlanStatus" NOT NULL DEFAULT 'NEEDS_BACKHAUL',
    "sourcedLoadId" TEXT,
    "puCityDh" TEXT,
    "puTimes" TEXT,
    "delCityDh" TEXT,
    "delTimes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPlanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingPlanEntry_sourcedLoadId_key" ON "BookingPlanEntry"("sourcedLoadId");

-- CreateIndex
CREATE INDEX "BookingPlanEntry_regionId_planDate_idx" ON "BookingPlanEntry"("regionId", "planDate");

-- CreateIndex
CREATE INDEX "BookingPlanEntry_driverId_idx" ON "BookingPlanEntry"("driverId");

-- AddForeignKey
ALTER TABLE "BookingPlanEntry" ADD CONSTRAINT "BookingPlanEntry_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPlanEntry" ADD CONSTRAINT "BookingPlanEntry_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPlanEntry" ADD CONSTRAINT "BookingPlanEntry_sourcedLoadId_fkey" FOREIGN KEY ("sourcedLoadId") REFERENCES "Load"("id") ON DELETE SET NULL ON UPDATE CASCADE;
