-- CreateTable
CREATE TABLE "RegionConfig" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "emptyPctAmber" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "emptyPctRed" DECIMAL(5,2) NOT NULL DEFAULT 25,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegionConfig_regionId_key" ON "RegionConfig"("regionId");

-- CreateIndex
CREATE INDEX "RegionConfig_regionId_idx" ON "RegionConfig"("regionId");

-- AddForeignKey
ALTER TABLE "RegionConfig" ADD CONSTRAINT "RegionConfig_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
