-- Generated from prisma/migrations/20261205000000_notification_subject/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

-- What a notification said, in a line, so the desk can show what went out (or what the demo desk would have sent). Never a body, a key or an address.
ALTER TABLE "notification_log" ADD COLUMN "subject" TEXT;
