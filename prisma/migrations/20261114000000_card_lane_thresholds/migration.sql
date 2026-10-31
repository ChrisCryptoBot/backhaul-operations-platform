-- The verdict card's two lane thresholds, one nullable column each. Null = use the built-in default (3 loads, 90 days), so nothing existing changes.
ALTER TABLE "workspaces" ADD COLUMN "lane_min_loads" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "lane_days" INTEGER;
