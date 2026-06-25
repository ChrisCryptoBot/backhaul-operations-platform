-- Daily Board full parity foundation

-- Ensure enums from older partially-applied environments exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TaskDoneStatus') THEN
    CREATE TYPE "TaskDoneStatus" AS ENUM ('NOT_DONE', 'DONE');
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "AttentionSeverity" AS ENUM ('INFO', 'WARN', 'URGENT');

-- CreateEnum
CREATE TYPE "PuDelStatusPreset" AS ENUM ('NOT_SET', 'ON_TIME', 'LATE', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "DriverType" AS ENUM ('SHUTTLE', 'PTP', 'LTL');

-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('DRY_VAN', 'REEFER', 'FLATBED', 'OTHER');

-- CreateEnum
CREATE TYPE "EquipmentAccessory" AS ENUM ('NONE', 'LIFTGATE', 'STRAPS', 'CHAINS', 'OTHER');

-- CreateEnum
CREATE TYPE "LoadLegType" AS ENUM ('SHUTTLE', 'PTP', 'DELIVERY');

-- AlterTable
ALTER TABLE "DropLot"
ADD COLUMN "code" VARCHAR(12),
ADD COLUMN "note" TEXT;

-- AlterTable
ALTER TABLE "Load"
ADD COLUMN "scaleBeforeTask" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN "scaleAfterTask" "TaskDoneStatus" NOT NULL DEFAULT 'NOT_DONE',
ADD COLUMN "puStatusPreset" "PuDelStatusPreset" NOT NULL DEFAULT 'NOT_SET',
ADD COLUMN "puStatusCustom" TEXT,
ADD COLUMN "delStatusPreset" "PuDelStatusPreset" NOT NULL DEFAULT 'NOT_SET',
ADD COLUMN "delStatusCustom" TEXT,
ADD COLUMN "attentionSeverity" "AttentionSeverity" NOT NULL DEFAULT 'INFO',
ADD COLUMN "attentionNote" TEXT,
ADD COLUMN "coordinatorNotes" TEXT,
ADD COLUMN "driverType" "DriverType",
ADD COLUMN "equipmentType" "EquipmentType",
ADD COLUMN "equipmentAccessory" "EquipmentAccessory",
ADD COLUMN "equipmentOtherText" TEXT,
ADD COLUMN "deliveryDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LoadLeg" (
  "id" TEXT NOT NULL,
  "loadId" TEXT NOT NULL,
  "legIndex" INTEGER NOT NULL,
  "legType" "LoadLegType" NOT NULL,
  "driverName" TEXT,
  "startCity" TEXT,
  "startState" TEXT,
  "endCity" TEXT,
  "endState" TEXT,
  "legMiles" DECIMAL(12,4),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoadLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoadLeg_loadId_legIndex_idx" ON "LoadLeg"("loadId", "legIndex");

-- AddForeignKey
ALTER TABLE "LoadLeg" ADD CONSTRAINT "LoadLeg_loadId_fkey"
FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;
