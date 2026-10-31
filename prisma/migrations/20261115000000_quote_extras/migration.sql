-- What a saved quote keeps beyond the load columns: the fuel price and its source, per-truck empty miles, which figures were typed by hand, and the driver picked. Nullable; nothing existing changes.
ALTER TABLE "loads" ADD COLUMN "quote_extras" JSONB;
