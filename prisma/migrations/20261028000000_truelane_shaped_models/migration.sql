-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "type" TEXT,
    "mpg" DECIMAL(8,3),
    "fuel_type" TEXT,
    "home_base_address" TEXT,
    "payload_lbs" INTEGER,
    "max_length_ft" DECIMAL(8,2),
    "max_width_ft" DECIMAL(8,2),
    "max_height_in" DECIMAL(8,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_profiles" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "monthly_insurance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthly_authority" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthly_phone_subscriptions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthly_loan_payment" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "estimated_monthly_miles" DECIMAL(12,2) NOT NULL,
    "maintenance_reserve_per_mile" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "tire_reserve_per_mile" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "driver_hourly_target" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "last_fuel_price_per_gallon" DECIMAL(6,3),
    "break_even_rpm" DECIMAL(8,4) NOT NULL,
    "survival_floor_rpm" DECIMAL(8,4),
    "archetype" TEXT,
    "insurance_liability_monthly" DECIMAL(12,2),
    "insurance_physical_damage_monthly" DECIMAL(12,2),
    "insurance_cargo_monthly" DECIMAL(12,2),
    "insurance_general_liability_monthly" DECIMAL(12,2),
    "insurance_other_monthly" DECIMAL(12,2),
    "other_fixed_monthly" DECIMAL(12,2),
    "truck_replacement_monthly" DECIMAL(12,2),
    "annual_fixed_costs" DECIMAL(12,2),
    "hired_driver_hourly_rate" DECIMAL(8,2),
    "hired_driver_pay_kind" TEXT,
    "hired_driver_rate_per_mile" DECIMAL(8,4),
    "labor_burden_pct" DECIMAL(6,4),
    "carrier_cut_pct" DECIMAL(6,4),
    "self_employment_tax_pct" DECIMAL(6,4),
    "fsc_cut_applies" TEXT,
    "factoring_fee_pct" DECIMAL(6,4),
    "detention_hourly_rate" DECIMAL(8,2),
    "free_grace_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "channel" TEXT,
    "broker_name" TEXT,
    "broker_mc_number" TEXT,
    "origin_address" TEXT,
    "destination_address" TEXT,
    "load_type" TEXT,
    "trailer_type" TEXT,
    "pickup_deadhead_miles" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "loaded_miles" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "return_deadhead_miles" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "quoted_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "actual_revenue" DECIMAL(12,2),
    "fuel_surcharge" DECIMAL(12,2),
    "fuel_surcharge_unit" TEXT,
    "layover_pay" DECIMAL(12,2),
    "tonu_revenue" DECIMAL(12,2),
    "expense_fuel_actual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expense_tolls" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expense_misc" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduled_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "payment_terms" TEXT,
    "pay_terms_days" INTEGER,
    "is_backhaul" BOOLEAN NOT NULL DEFAULT false,
    "stops_count" INTEGER,
    "dock_wait_minutes" INTEGER,
    "factoring_fee_pct" DECIMAL(6,4),
    "insurance_rider_flat" DECIMAL(12,2),
    "market_benchmark" DECIMAL(12,4),
    "quoted_pickup_dh_miles" DECIMAL(12,4),
    "quoted_loaded_miles" DECIMAL(12,4),
    "quoted_return_dh_miles" DECIMAL(12,4),
    "load_number" TEXT,
    "po_number" TEXT,
    "pickup_numbers" JSONB,
    "delivery_numbers" JSONB,
    "rate_con_path" TEXT,
    "closed_without_pod" BOOLEAN,
    "invoice_number" TEXT,
    "invoiced_amount" DECIMAL(12,2),
    "payment_status" TEXT,
    "invoiced_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "paid_amount" DECIMAL(12,2),
    "snapshot_base_floor_rpm" DECIMAL(8,4),
    "snapshot_total_insurance_monthly" DECIMAL(12,2),
    "snapshot_estimated_monthly_miles" DECIMAL(12,2),
    "snapshot_archetype" TEXT,
    "snapshot_carrier_cut_pct" DECIMAL(6,4),
    "snapshot_labor_cpm" DECIMAL(8,4),
    "snapshot_mpg" DECIMAL(8,3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "loads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stops" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "stop_sequence" INTEGER NOT NULL,
    "address_string" TEXT NOT NULL,
    "lat" DECIMAL(9,6),
    "lng" DECIMAL(9,6),
    "stop_type" TEXT NOT NULL,
    "stop_role" TEXT,
    "reference_numbers" JSONB,
    "time_window_earliest" TIMESTAMP(3),
    "time_window_latest" TIMESTAMP(3),
    "pod_photo_url" TEXT,
    "facility_name" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "stop_notes" TEXT,
    "wait_minutes" INTEGER,
    "arrived_at" TIMESTAMP(3),
    "seal_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_segments" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "segment_type" TEXT NOT NULL,
    "miles" DECIMAL(12,4) NOT NULL,
    "duration_minutes" INTEGER,
    "fuel_cost" DECIMAL(12,2),
    "is_manual_override" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_decisions" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "decision_type" TEXT NOT NULL,
    "override_reason" TEXT,
    "override_notes" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "load_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "cdl_class" TEXT,
    "cdl_expiry" TIMESTAMP(3),
    "medical_card_expiry" TIMESTAMP(3),
    "assigned_vehicle_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "load_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "pay_kind" TEXT NOT NULL,
    "pay_rate" DECIMAL(12,4) NOT NULL,
    "pay_estimate" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "assignment_version" INTEGER NOT NULL DEFAULT 1,
    "driver_response" JSONB,
    "dispatched_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicles_workspace_id_idx" ON "vehicles"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_profiles_vehicle_id_key" ON "cost_profiles"("vehicle_id");

-- CreateIndex
CREATE INDEX "loads_workspace_id_status_idx" ON "loads"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "loads_vehicle_id_idx" ON "loads"("vehicle_id");

-- CreateIndex
CREATE INDEX "loads_completed_at_idx" ON "loads"("completed_at");

-- CreateIndex
CREATE INDEX "stops_load_id_stop_sequence_idx" ON "stops"("load_id", "stop_sequence");

-- CreateIndex
CREATE INDEX "trip_segments_load_id_idx" ON "trip_segments"("load_id");

-- CreateIndex
CREATE INDEX "load_decisions_load_id_idx" ON "load_decisions"("load_id");

-- CreateIndex
CREATE INDEX "drivers_workspace_id_idx" ON "drivers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_load_id_key" ON "assignments"("load_id");

-- CreateIndex
CREATE INDEX "assignments_driver_id_status_idx" ON "assignments"("driver_id", "status");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_profiles" ADD CONSTRAINT "cost_profiles_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loads" ADD CONSTRAINT "loads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loads" ADD CONSTRAINT "loads_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stops" ADD CONSTRAINT "stops_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_segments" ADD CONSTRAINT "trip_segments_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_decisions" ADD CONSTRAINT "load_decisions_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_assigned_vehicle_id_fkey" FOREIGN KEY ("assigned_vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

