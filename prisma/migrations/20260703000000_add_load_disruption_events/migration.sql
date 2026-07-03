-- CreateEnum
CREATE TYPE "DisruptionKind" AS ENUM ('CANCEL', 'RESCHEDULE');

-- CreateEnum
CREATE TYPE "DisruptionReason" AS ENUM ('CARRIER_NO_SHOW', 'CARRIER_LATE_OR_NOT_EMPTY', 'PARTY_RESCHEDULE', 'NO_DOCK_TIME', 'WEATHER_ROAD', 'EQUIPMENT_ISSUE', 'RATE_BILLING_DISPUTE', 'LOAD_PULLED', 'OTHER');

-- CreateTable
CREATE TABLE "LoadDisruptionEvent" (
    "id" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "weekIso" TEXT NOT NULL,
    "kind" "DisruptionKind" NOT NULL,
    "reason" "DisruptionReason" NOT NULL,
    "detail" TEXT,
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadDisruptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoadDisruptionEvent_regionId_weekIso_kind_idx" ON "LoadDisruptionEvent"("regionId", "weekIso", "kind");

-- CreateIndex
CREATE INDEX "LoadDisruptionEvent_loadId_idx" ON "LoadDisruptionEvent"("loadId");

-- AddForeignKey
ALTER TABLE "LoadDisruptionEvent" ADD CONSTRAINT "LoadDisruptionEvent_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadDisruptionEvent" ADD CONSTRAINT "LoadDisruptionEvent_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
