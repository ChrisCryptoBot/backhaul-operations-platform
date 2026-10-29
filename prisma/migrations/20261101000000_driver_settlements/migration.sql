-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "hours" JSONB,
    "adjustments" JSONB,
    "lines" JSONB,
    "total" DECIMAL(12,2),
    "finalized_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_loads" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "settlement_loads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_workspace_id_status_idx" ON "settlements"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "settlements_driver_id_idx" ON "settlements"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_workspace_id_number_key" ON "settlements"("workspace_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_loads_load_id_key" ON "settlement_loads"("load_id");

-- CreateIndex
CREATE INDEX "settlement_loads_settlement_id_idx" ON "settlement_loads"("settlement_id");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_loads" ADD CONSTRAINT "settlement_loads_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_loads" ADD CONSTRAINT "settlement_loads_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

