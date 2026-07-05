-- Workflow-alignment + DAT market rate (Phase 0).
-- Additive only. The FuelSurchargeSource enum block from `migrate diff` is
-- pre-existing DB drift (cosmetic enum ordering) and is intentionally excluded.

-- AlterTable: BookingPlanEntry — carry broker + booked amount onto Book.
ALTER TABLE "BookingPlanEntry" ADD COLUMN     "bookedAmount" DECIMAL(12,4),
ADD COLUMN     "brokerId" TEXT;

-- AlterTable: Load — DAT market rate snapshot, direct-customer source, and the
-- three booking/paperwork gates.
ALTER TABLE "Load" ADD COLUMN     "directCustomerId" TEXT,
ADD COLUMN     "marketRate" DECIMAL(12,4),
ADD COLUMN     "mgRateUpdated" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "rateConReceived" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN     "receiptReceived" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE';

-- CreateTable: DatProviderConfig — encrypted DAT API key (mirrors LlmProviderConfig).
CREATE TABLE "DatProviderConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "apiKeyCipher" TEXT,
    "apiKeyLast4" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Load_brokerId_idx" ON "Load"("brokerId");

-- CreateIndex
CREATE INDEX "Load_directCustomerId_idx" ON "Load"("directCustomerId");

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_directCustomerId_fkey" FOREIGN KEY ("directCustomerId") REFERENCES "DirectCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPlanEntry" ADD CONSTRAINT "BookingPlanEntry_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
