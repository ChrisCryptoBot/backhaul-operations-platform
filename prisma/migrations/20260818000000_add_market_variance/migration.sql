-- Market Variance: live DAT lane rates + negotiation tracker.
-- Additive only. Reference ids on both tables are plain scalars (no FK) so this
-- cache + append-only log never cascades from loads/brokers/customers. The
-- FuelSurchargeSource enum block from `migrate diff` is pre-existing DB drift and
-- is intentionally excluded.

-- CreateEnum
CREATE TYPE "DatEquipment" AS ENUM ('VAN', 'REEFER', 'FLATBED');

-- CreateEnum
CREATE TYPE "DatRateType" AS ENUM ('SPOT', 'CONTRACT');

-- CreateEnum
CREATE TYPE "MarketPerformanceBand" AS ENUM ('ABOVE', 'AT', 'BELOW');

-- CreateTable
CREATE TABLE "MarketRateQuote" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "originCity" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "destCity" TEXT NOT NULL,
    "destState" TEXT NOT NULL,
    "equipment" "DatEquipment" NOT NULL,
    "rateType" "DatRateType" NOT NULL,
    "ratePerMileLow" DECIMAL(12,4) NOT NULL,
    "ratePerMileAvg" DECIMAL(12,4) NOT NULL,
    "ratePerMileHigh" DECIMAL(12,4) NOT NULL,
    "fuelPerMile" DECIMAL(12,4),
    "mileage" DECIMAL(12,4),
    "reportCount" INTEGER,
    "timeframe" TEXT,
    "source" TEXT NOT NULL,
    "raw" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketRateQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketVarianceEntry" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "originCity" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "destCity" TEXT NOT NULL,
    "destState" TEXT NOT NULL,
    "equipment" "DatEquipment" NOT NULL,
    "rateType" "DatRateType" NOT NULL,
    "negotiatedTotal" DECIMAL(12,4) NOT NULL,
    "negotiatedPerMile" DECIMAL(12,4) NOT NULL,
    "miles" DECIMAL(12,4) NOT NULL,
    "milesSource" TEXT NOT NULL,
    "marketPerMile" DECIMAL(12,4) NOT NULL,
    "marketTotal" DECIMAL(12,4) NOT NULL,
    "variancePerMile" DECIMAL(12,4) NOT NULL,
    "varianceTotal" DECIMAL(12,4) NOT NULL,
    "variancePct" DECIMAL(9,4) NOT NULL,
    "band" "MarketPerformanceBand" NOT NULL,
    "loadId" TEXT,
    "brokerId" TEXT,
    "directCustomerId" TEXT,
    "quoteId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketVarianceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketRateQuote_regionId_originCity_originState_destCity_des_key" ON "MarketRateQuote"("regionId", "originCity", "originState", "destCity", "destState", "equipment", "rateType");

-- CreateIndex
CREATE INDEX "MarketRateQuote_regionId_fetchedAt_idx" ON "MarketRateQuote"("regionId", "fetchedAt");

-- CreateIndex
CREATE INDEX "MarketVarianceEntry_regionId_createdAt_idx" ON "MarketVarianceEntry"("regionId", "createdAt");
