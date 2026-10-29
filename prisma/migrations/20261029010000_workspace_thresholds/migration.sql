-- The desk's thresholds, one nullable column each. Null = use the built-in default, so nothing existing changes.
ALTER TABLE "workspaces" ADD COLUMN "empty_amber_pct" DECIMAL(5,2);
ALTER TABLE "workspaces" ADD COLUMN "empty_red_pct" DECIMAL(5,2);
ALTER TABLE "workspaces" ADD COLUMN "default_pay_terms_days" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "detention_grace_minutes" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "alert_pickup_hours" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "alert_sent_hours" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "alert_clearance_days" INTEGER;
