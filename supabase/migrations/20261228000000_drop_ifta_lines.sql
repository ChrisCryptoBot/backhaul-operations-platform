-- Generated from prisma/migrations/20261228000000_drop_ifta_lines/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- Drop ifta_lines (docs/MONEY_PLAN.md, Wave 5 step 9). Nothing has read or written it since step 5b: a quarter's miles live in ifta_mileage (ELD and routed) and the return is worked out
-- from them (server/partners/ifta-return.ts) and frozen in ifta_returns when filed. Its rows were the mileage company's old per-quarter answer, with gallons estimated from miles per gallon.

DROP TABLE IF EXISTS "ifta_lines";
