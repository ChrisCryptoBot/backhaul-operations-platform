-- Generated from prisma/migrations/20261115000000_quote_extras/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- What a saved quote keeps beyond the load columns: the fuel price and its source, per-truck empty miles, which figures were typed by hand, and the driver picked. Nullable; nothing existing changes.
ALTER TABLE "loads" ADD COLUMN "quote_extras" JSONB;
